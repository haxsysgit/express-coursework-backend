// =================================================================
// COURSEWORK BACKEND SERVER - BEGINNER FRIENDLY VERSION
// =================================================================
// This is a web server built with Node.js and Express.js
// It handles lesson data and orders for an online tutoring platform
// =================================================================

// STEP 1: IMPORT REQUIRED PACKAGES
// =================================

// Express is a web framework for Node.js - it helps us create web servers easily
const express = require('express');

// CORS (Cross-Origin Resource Sharing) allows our frontend to talk to our backend
// Without this, browsers would block requests from our frontend
const cors = require('cors');

// Path helps us work with file and directory paths
const path = require('path');

// Helmet adds security headers to protect our app from common attacks
const helmet = require('helmet');

// Crypto helps us generate unique IDs for requests
const crypto = require('crypto');

// Compression makes our responses smaller so they load faster
const compression = require('compression');

// Rate limiter prevents people from making too many requests too quickly
const rateLimit = require('express-rate-limit');

// MongoDB driver lets us connect to our MongoDB database
const { MongoClient } = require('mongodb');

// Dotenv loads environment variables from a .env file
// Environment variables are like secret settings for our app
const dotenv = require('dotenv');

// STEP 2: LOAD ENVIRONMENT VARIABLES
// ===================================
// This reads the .env file and makes the variables available
dotenv.config({ path: path.join(__dirname, '.env') });

// Get our environment variables (settings)
const mongoConnectionString = process.env.MONGODB_URI; // Database connection string
const databaseName = process.env.DB_NAME || 'coursework-backend'; // Database name
const allowedOrigins = process.env.CORS_ORIGINS || 'http://localhost:5173'; // Which websites can use our API

// STEP 3: CREATE EXPRESS APPLICATION
// ===================================
const app = express();

// Tell Express to trust proxy servers (needed for deployment)
app.set('trust proxy', 1);

// STEP 4: SET UP DATABASE CONNECTION VARIABLES
// =============================================
let mongoClient = null; // Will store our database connection
let database = null; // Will store our database object

// This function connects to MongoDB and returns the database
async function connectToDatabase() {
    // If we already have a database connection, use it
    if (database) {
        return database;
    }
    
    // Check if we have a connection string
    if (!mongoConnectionString) {
        throw new Error('MONGODB_URI environment variable is not set!');
    }
    
    // Create a new MongoDB client
    mongoClient = new MongoClient(mongoConnectionString);
    
    // Connect to MongoDB
    await mongoClient.connect();
    console.log('✅ Connected to MongoDB Atlas');
    
    // Get the database
    database = mongoClient.db(databaseName);
    
    return database;
}

// STEP 5: HELPER FUNCTIONS
// =========================

// This function checks if an ID is a valid positive number
function isValidNumericId(id) {
    const numberValue = Number(id); // Convert to number
    // Check if it's a positive integer
    if (Number.isInteger(numberValue) && numberValue > 0) {
        return numberValue;
    }
    return null; // Return null if invalid
}

// This function escapes special characters in search terms
// This prevents users from breaking our search with special characters
function escapeSpecialCharacters(searchTerm) {
    // Replace special regex characters with escaped versions
    return String(searchTerm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// This function validates and prepares order data
function validateOrderData(orderBody) {
    // Get the data from the request
    const { name, phone, lessonIDs, space, items } = orderBody || {};
    
    // Check if name is valid (only letters and spaces)
    const isNameValid = typeof name === 'string' && /^[A-Za-z ]+$/.test(name);
    
    // Check if phone is valid (only numbers)
    const isPhoneValid = typeof phone === 'string' && /^[0-9]+$/.test(phone);
    
    // If name or phone is invalid, return an error
    if (!isNameValid || !isPhoneValid) {
        return { error: 'Invalid name or phone number' };
    }
    
    // Handle orders with items array (multiple lessons)
    if (Array.isArray(items) && items.length > 0) {
        // Check each item
        for (const item of items) {
            const spaceNumber = Number(item.space);
            // Make sure space is a positive number
            if (!Number.isFinite(spaceNumber) || spaceNumber <= 0) {
                return { error: 'Each item must have a positive space number' };
            }
        }
        
        // Prepare the items for database
        const preparedItems = items.map(item => {
            // Get lesson ID (might be called different things)
            const lessonId = item.lessonId || item.lessonID || item.id;
            const validId = isValidNumericId(lessonId);
            
            return {
                lessonId: validId ? validId : Number(lessonId),
                space: Number(item.space)
            };
        });
        
        // Return the validated order document
        return {
            document: {
                name: name,
                phone: phone,
                items: preparedItems,
                createdAt: new Date() // Add timestamp
            }
        };
    }
    
    // Handle orders with lessonIDs array (single space value)
    if (Array.isArray(lessonIDs) && lessonIDs.length > 0 && space !== undefined) {
        const spaceNumber = Number(space);
        
        // Check if space is valid
        if (!Number.isFinite(spaceNumber) || spaceNumber <= 0) {
            return { error: 'Space must be a positive number' };
        }
        
        // Convert all IDs to numbers
        const numericIds = lessonIDs.map(id => {
            const validId = isValidNumericId(id);
            return validId ? validId : Number(id);
        });
        
        // Return the validated order document
        return {
            document: {
                name: name,
                phone: phone,
                lessonIDs: numericIds,
                space: spaceNumber,
                createdAt: new Date() // Add timestamp
            }
        };
    }
    
    // If neither format is provided, return error
    return { error: 'Please provide either items[] or lessonIDs[] with space' };
}

// STEP 6: SET UP MIDDLEWARE
// ==========================
// Middleware are functions that run before our routes

// Add security headers
app.use(helmet({
    contentSecurityPolicy: false, // We disable CSP for simplicity
}));

// Compress responses to make them smaller
app.use(compression());

// Parse JSON request bodies (so we can read JSON data sent to us)
app.use(express.json({ limit: '10mb' })); // Max 10MB JSON

// Parse URL-encoded bodies (for form submissions)
app.use(express.urlencoded({ extended: true }));

// Set up CORS (which websites can use our API)
const corsOptions = {
    origin: function(origin, callback) {
        // Split allowed origins by comma
        const allowedOriginsList = allowedOrigins.split(',').map(o => o.trim());
        
        // Allow requests with no origin (like Postman) or allowed origins
        if (!origin || allowedOriginsList.includes(origin)) {
            callback(null, true); // Allow the request
        } else {
            callback(null, false); // Block the request
        }
    },
    credentials: true, // Allow cookies
};
app.use(cors(corsOptions));

// Add rate limiting (max 100 requests per minute per IP)
const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests max
    message: 'Too many requests, please try again later',
});
app.use('/api/', limiter); // Apply to all /api routes

// Request ID middleware - adds a unique ID to each request
app.use((req, res, next) => {
    // Generate a random ID for this request
    req.requestId = crypto.randomBytes(8).toString('hex');
    next(); // Continue to next middleware
});

// Logging middleware - logs all requests
app.use((req, res, next) => {
    const startTime = Date.now(); // Record start time
    
    // When the response finishes, log it
    res.on('finish', () => {
        const duration = Date.now() - startTime; // Calculate how long it took
        console.log(
            `[${new Date().toISOString()}]`, // Timestamp
            req.method, // GET, POST, etc.
            req.path, // URL path
            res.statusCode, // 200, 404, etc.
            `${duration}ms`, // How long it took
            `ID:${req.requestId}` // Request ID
        );
    });
    
    next(); // Continue to next middleware
});

// STEP 7: DEFINE ROUTES
// ======================
// Routes are the URLs that our server responds to

// HOME ROUTE - GET /
// Shows basic information about our API
app.get('/', (req, res) => {
    res.json({
        ok: true,
        message: 'Welcome to the Coursework Backend API',
        endpoints: {
            'GET /': 'This help message',
            'GET /lessons': 'Get all lessons',
            'GET /lessons/:id': 'Get a specific lesson by ID',
            'GET /search?term=...': 'Search for lessons',
            'POST /orders': 'Create a new order',
            'PUT /lessons/:id': 'Update a lesson'
        },
        requestId: req.requestId
    });
});

// GET ALL LESSONS - GET /lessons
// Returns all lessons from the database
app.get('/lessons', async (req, res) => {
    try {
        // Connect to database
        const db = await connectToDatabase();
        
        // Get all lessons from the 'lesson' collection
        const lessons = await db.collection('lesson').find({}).toArray();
        
        // Send the lessons as JSON
        res.json(lessons);
        
    } catch (error) {
        // If something goes wrong, send an error
        console.error('Error fetching lessons:', error);
        res.status(500).json({ 
            error: 'Failed to fetch lessons',
            requestId: req.requestId 
        });
    }
});

// GET SINGLE LESSON - GET /lessons/:id
// Returns one lesson by its ID
app.get('/lessons/:id', async (req, res) => {
    try {
        // Get the ID from the URL
        const lessonId = Number(req.params.id);
        
        // Check if ID is valid
        if (!Number.isInteger(lessonId) || lessonId <= 0) {
            return res.status(400).json({ 
                error: 'Invalid ID - must be a positive number',
                requestId: req.requestId 
            });
        }
        
        // Connect to database
        const db = await connectToDatabase();
        
        // Find the lesson with this ID
        const lesson = await db.collection('lesson').findOne({ _id: lessonId });
        
        // If no lesson found, return 404
        if (!lesson) {
            return res.status(404).json({ 
                error: 'Lesson not found',
                requestId: req.requestId 
            });
        }
        
        // Send the lesson
        res.json(lesson);
        
    } catch (error) {
        // If something goes wrong, send an error
        console.error('Error fetching lesson:', error);
        res.status(500).json({ 
            error: 'Failed to fetch lesson',
            requestId: req.requestId 
        });
    }
});

// SEARCH LESSONS - GET /search?term=...
// Search for lessons by topic, location, or other fields
app.get('/search', async (req, res) => {
    try {
        // Get the search term from query parameters
        const searchTerm = req.query.term;
        
        // If no search term provided, return error
        if (!searchTerm) {
            return res.status(400).json({ 
                error: 'Please provide a search term using ?term=...',
                requestId: req.requestId 
            });
        }
        
        // Connect to database
        const db = await connectToDatabase();
        
        // Escape special characters in search term
        const escapedTerm = escapeSpecialCharacters(searchTerm);
        
        // Create search pattern (case-insensitive)
        const searchPattern = new RegExp(escapedTerm, 'i');
        
        // Search in multiple fields
        const searchQuery = {
            $or: [ // Match any of these conditions
                { topic: searchPattern },      // Search in topic
                { location: searchPattern },   // Search in location
                { description: searchPattern }  // Search in description
            ]
        };
        
        // Execute search
        const results = await db.collection('lesson').find(searchQuery).toArray();
        
        // Send results
        res.json({
            searchTerm: searchTerm,
            resultCount: results.length,
            results: results
        });
        
    } catch (error) {
        // If something goes wrong, send an error
        console.error('Error searching lessons:', error);
        res.status(500).json({ 
            error: 'Search failed',
            requestId: req.requestId 
        });
    }
});

// CREATE ORDER - POST /orders
// Creates a new order in the database
app.post('/orders', async (req, res) => {
    try {
        // Validate the order data
        const validationResult = validateOrderData(req.body);
        
        // If validation failed, return error
        if (validationResult.error) {
            return res.status(400).json({ 
                error: validationResult.error,
                requestId: req.requestId 
            });
        }
        
        // Get the validated order document
        const orderDocument = validationResult.document;
        
        // Connect to database
        const db = await connectToDatabase();
        
        // Insert the order into the 'order' collection
        const insertResult = await db.collection('order').insertOne(orderDocument);
        
        // Send success response
        res.status(201).json({
            success: true,
            message: 'Order created successfully',
            orderId: insertResult.insertedId,
            order: orderDocument,
            requestId: req.requestId
        });
        
    } catch (error) {
        // If something goes wrong, send an error
        console.error('Error creating order:', error);
        res.status(500).json({ 
            error: 'Failed to create order',
            requestId: req.requestId 
        });
    }
});

// UPDATE LESSON - PUT /lessons/:id
// Updates a lesson's information
app.put('/lessons/:id', async (req, res) => {
    try {
        // Get the ID from the URL
        const lessonId = Number(req.params.id);
        
        // Check if ID is valid
        if (!Number.isInteger(lessonId) || lessonId <= 0) {
            return res.status(400).json({ 
                error: 'Invalid ID - must be a positive number',
                requestId: req.requestId 
            });
        }
        
        // Get the update data from request body
        const updateData = { ...req.body }; // Copy the data
        
        // Remove _id if it was included (we can't update the ID)
        if ('_id' in updateData) {
            delete updateData._id;
        }
        
        // If updating space, make sure it's a number
        if (updateData.space !== null && updateData.space !== undefined) {
            const spaceNumber = Number(updateData.space);
            if (!Number.isFinite(spaceNumber)) {
                return res.status(400).json({ 
                    error: 'Space must be a number',
                    requestId: req.requestId 
                });
            }
            updateData.space = spaceNumber;
        }
        
        // Connect to database
        const db = await connectToDatabase();
        
        // Update the lesson
        const updateResult = await db.collection('lesson').updateOne(
            { _id: lessonId }, // Find lesson with this ID
            { $set: updateData } // Update with new data
        );
        
        // Check if lesson was found
        if (updateResult.matchedCount === 0) {
            return res.status(404).json({ 
                error: 'Lesson not found',
                requestId: req.requestId 
            });
        }
        
        // Get the updated lesson
        const updatedLesson = await db.collection('lesson').findOne({ _id: lessonId });
        
        // Send the updated lesson
        res.json({
            success: true,
            message: 'Lesson updated successfully',
            lesson: updatedLesson,
            requestId: req.requestId
        });
        
    } catch (error) {
        // If something goes wrong, send an error
        console.error('Error updating lesson:', error);
        res.status(500).json({ 
            error: 'Failed to update lesson',
            requestId: req.requestId 
        });
    }
});

// SERVE STATIC FILES - Images
// This serves image files from the imgs folder
app.use('/imgs', express.static(path.join(__dirname, 'imgs')));

// GET VERSION INFO - GET /version
// Shows version information about the app
app.get('/version', (req, res) => {
    res.json({
        version: require('./package.json').version,
        node: process.version,
        environment: process.env.NODE_ENV || 'development',
        requestId: req.requestId
    });
});

// HEALTH CHECK - GET /health/db
// Checks if the database connection is active
app.get('/health/db', async (req, res) => {
    try {
        const db = await connectToDatabase();
        // Run a simple command to check connection
        const ping = await db.command({ ping: 1 });
        
        res.json({
            status: 'ok',
            database: 'connected',
            ping: ping,
            requestId: req.requestId
        });
    } catch (error) {
        console.error('Health check failed:', error);
        res.status(500).json({
            status: 'error',
            database: 'disconnected',
            error: error.message,
            requestId: req.requestId
        });
    }
});

// HEALTH CHECK - GET /health
// Used to check if the server is running
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(), // How long server has been running
        requestId: req.requestId
    });
});

// STEP 8: ERROR HANDLING
// =======================

// 404 Handler - Catches all undefined routes
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Route not found',
        message: `The route ${req.method} ${req.path} does not exist`,
        requestId: req.requestId 
    });
});

// 500 Handler - Catches all errors
app.use((err, req, res, next) => {
    // Log the error
    console.error('❌ Error:', err.message);
    
    // Send error response
    res.status(500).json({ 
        error: 'Internal server error',
        message: 'Something went wrong on the server',
        requestId: req.requestId 
    });
});

// STEP 9: START THE SERVER
// =========================

// Get the port number (from environment or default to 3000)
const port = process.env.PORT || 3000;

// Start the server
const server = app.listen(port, () => {
    console.log('========================================');
    console.log('🚀 Server started successfully!');
    console.log(`📡 Listening on port ${port}`);
    console.log(`🌐 Visit http://localhost:${port}`);
    console.log('========================================');
});

// STEP 10: GRACEFUL SHUTDOWN
// ===========================
// This ensures the server closes properly when stopped

// Function to shut down gracefully
async function shutdownGracefully() {
    console.log('\n📴 Shutting down server...');
    
    try {
        // Close database connection
        if (mongoClient) {
            await mongoClient.close();
            console.log('✅ Database connection closed');
        }
    } catch (error) {
        console.error('❌ Error closing database:', error);
    }
    
    // Close the server
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0); // Exit successfully
    });
    
    // Force exit after 5 seconds if not closed
    setTimeout(() => {
        console.log('⚠️  Forcing shutdown...');
        process.exit(0);
    }, 5000);
}

// Listen for shutdown signals
process.on('SIGINT', shutdownGracefully);  // Ctrl+C
process.on('SIGTERM', shutdownGracefully); // Termination signal

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    shutdownGracefully();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    shutdownGracefully();
});

// End of server.js
