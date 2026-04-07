import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

const envFile = process.env.NODE_ENV === 'development' ? '.env.development' : '.env';
dotenv.config({ path: envFile });

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  })
});

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const app = express();

// Security Middleware
app.use(helmet());

// CORS configuration
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 600
};
app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Body parser with size limits
app.use(express.json({ limit: '10kb' }));

// Validate color format (hex color)
const isValidColor = (color) => {
  if (!color || typeof color !== 'string') return true; // Color is optional
  const hexColorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
  return hexColorRegex.test(color) || color === '';
};

// Input validation middleware
const validateTaskInput = (req, res, next) => {
  const { title, color } = req.body;

  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'Title is required and must be a string' });
  }

  if (title.trim().length === 0 || title.length > 500) {
    return res.status(400).json({ error: 'Title must be between 1 and 500 characters' });
  }

  if (color && !isValidColor(color)) {
    return res.status(400).json({ error: 'Color must be a valid hex color (e.g., #FF6B6B)' });
  }

  // Sanitize title
  req.body.title = title.trim();
  next();
};

// Sanitize update data
const sanitizeUpdateData = (updates) => {
  const allowedFields = ['title', 'completed', 'category', 'description', 'dueDate', 'color'];
  const sanitized = {};

  for (const key of Object.keys(updates)) {
    if (allowedFields.includes(key)) {
      if (key === 'title' && typeof updates[key] === 'string') {
        sanitized[key] = updates[key].trim().substring(0, 500);
      } else if (key === 'completed' && typeof updates[key] === 'boolean') {
        sanitized[key] = updates[key];
      } else if (key === 'category' && typeof updates[key] === 'string') {
        sanitized[key] = updates[key].trim().substring(0, 100);
      } else if (key === 'description' && typeof updates[key] === 'string') {
        sanitized[key] = updates[key].trim().substring(0, 2000);
      } else if (key === 'dueDate' && typeof updates[key] === 'string') {
        sanitized[key] = updates[key].trim();
      } else if (key === 'color' && typeof updates[key] === 'string') {
        if (isValidColor(updates[key])) {
          sanitized[key] = updates[key].trim();
        }
      }
    }
  }

  return sanitized;
};

const formatTaskData = (doc) => {
  const data = doc.data();
  return {
    id: doc.id,
    title: data.title,
    description: data.description || '',
    color: data.color || '',
    dueDate: data.dueDate || '',
    completed: data.completed,
    category: data.category || '',
    createdAt: data.createdAt?.toDate?.() ? data.createdAt.toDate().toISOString() : data.createdAt,
    updatedAt: data.updatedAt?.toDate?.() ? data.updatedAt.toDate().toISOString() : new Date().toISOString()
  };
};

app.get('/tasks', async (req, res) => {
  try {
    // Pagination
    const limit = Math.min(Number.parseInt(req.query.limit) || 50, 100);
    const offset = Number.parseInt(req.query.offset) || 0;

    let query = db.collection('tasks').orderBy('createdAt', 'desc');

    if (offset > 0) {
      const offsetSnapshot = await query.limit(offset).get();
      const lastDoc = offsetSnapshot.docs[offsetSnapshot.docs.length - 1];
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }
    }

    const tasksSnapshot = await query.limit(limit).get();
    const tasks = [];

    tasksSnapshot.forEach(doc => {
      tasks.push(formatTaskData(doc));
    });

    res.json(tasks);
  } catch (error) {
    console.error('Error fetching tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

app.post('/tasks', validateTaskInput, async (req, res) => {
  try {
    const { title, description = '', color = '', dueDate = '', category = '' } = req.body;

    // Validate color format
    if (color && !isValidColor(color)) {
      return res.status(400).json({ error: 'Color must be a valid hex color (e.g., #FF6B6B)' });
    }

    const taskRef = db.collection('tasks').doc();
    const task = {
      id: taskRef.id,
      title,
      description: typeof description === 'string' ? description.trim().substring(0, 2000) : '',
      color: isValidColor(color) ? (typeof color === 'string' ? color.trim() : '') : '',
      dueDate: typeof dueDate === 'string' ? dueDate.trim() : '',
      category: typeof category === 'string' ? category.trim().substring(0, 100) : '',
      completed: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    await taskRef.set(task);

    const createdTask = await taskRef.get();
    res.status(201).json(formatTaskData(createdTask));
  } catch (error) {
    console.error('Error creating task:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

app.patch('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID format
    if (!id || typeof id !== 'string' || id.length > 100) {
      return res.status(400).json({ error: 'Invalid task ID' });
    }

    const sanitizedUpdates = sanitizeUpdateData(req.body);

    if (Object.keys(sanitizedUpdates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const taskRef = db.collection('tasks').doc(id);
    const task = await taskRef.get();

    if (!task.exists) {
      return res.status(404).json({ error: 'Task not found' });
    }

    sanitizedUpdates.updatedAt = FieldValue.serverTimestamp();
    await taskRef.update(sanitizedUpdates);

    const updatedTask = await taskRef.get();
    res.json(formatTaskData(updatedTask));
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

app.delete('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID format
    if (!id || typeof id !== 'string' || id.length > 100) {
      return res.status(400).json({ error: 'Invalid task ID' });
    }

    const taskRef = db.collection('tasks').doc(id);
    const task = await taskRef.get();

    if (!task.exists) {
      return res.status(404).json({ error: 'Task not found' });
    }

    await taskRef.delete();
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

app.get('/categories', async (req, res) => {
  try {
    const categoriesSnapshot = await db.collection('categories').orderBy('createdAt', 'desc').get();
    const categories = [];

    categoriesSnapshot.forEach(doc => {
      const data = doc.data();
      categories.push({
        id: doc.id,
        title: data.title,
        description: data.description,
        createdAt: data.createdAt?.toDate?.() ? data.createdAt.toDate().toISOString() : data.createdAt
      });
    });

    res.json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

app.post('/categories', async (req, res) => {
  try {
    const { title, description } = req.body;

    if (!title || typeof title !== 'string' || title.trim().length === 0 || title.length > 500) {
      return res.status(400).json({ error: 'Title is required and must be a non-empty string up to 500 characters' });
    }

    const categoryRef = db.collection('categories').doc();
    const category = {
      id: categoryRef.id,
      title: title.trim(),
      description: typeof description === 'string' ? description.trim().substring(0, 1000) : '',
      createdAt: FieldValue.serverTimestamp()
    };

    await categoryRef.set(category);

    const createdCategory = await categoryRef.get();
    res.status(201).json({
      id: createdCategory.id,
      title: createdCategory.data().title,
      description: createdCategory.data().description,
      createdAt: createdCategory.data().createdAt?.toDate?.() ? createdCategory.data().createdAt.toDate().toISOString() : createdCategory.data().createdAt
    });
  } catch (error) {
    console.error('Error creating category:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});


app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: 'Internal server error'
  });
});

const PORT = process.env.PORT || 3000;

let server;
if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
      console.log('HTTP server closed');
    });
  });
}

export { app, server };