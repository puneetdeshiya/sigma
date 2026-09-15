const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const crypto = require('crypto');

dotenv.config({ path: require('path').resolve(__dirname, '../.env') });

const app = express();
const server = http.createServer(app);
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const configuredOrigins = CLIENT_URL.split(',').map((origin) => origin.trim()).filter(Boolean);
const allowedOrigins = (origin) => {
  if (!origin) return true;
  return configuredOrigins.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
};

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (allowedOrigins(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;

if (!MONGODB_URI || !JWT_SECRET) {
  console.error('Missing required environment variables. Check your .env file.');
  process.exit(1);
}

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (allowedOrigins(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again later.' }
});

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  displayName: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true },
  email: { type: String, default: '' },
  profile: { type: String, default: '' },
  avatar: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  online: { type: Boolean, default: false }
}, { collection: 'users' });

const friendRequestSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'friend_requests' });

const User = mongoose.model('User', userSchema);
const FriendRequest = mongoose.model('FriendRequest', friendRequestSchema);

const activeChats = new Map();
const activeTypingUsers = new Map();
const onlineUsers = new Map();
const memoryUsers = new Map();
const memoryFriendRequests = [];
let mongoReady = false;

const normalizeText = (text) => {
  return String(text || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 2000);
};

const createToken = (user) => {
  return jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, {
    expiresIn: '7d'
  });
};

const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
};

const sanitizeUser = (user) => ({
  _id: user._id,
  username: user.username,
  displayName: user.displayName,
  email: user.email,
  profile: user.profile,
  avatar: user.avatar,
  lastSeen: user.lastSeen,
  online: user.online
});

const createMemoryId = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const getUserById = async (id) => {
  if (mongoReady) {
    return User.findById(id);
  }

  return memoryUsers.get(String(id)) || null;
};

const findUserByUsername = async (username) => {
  if (mongoReady) {
    return User.findOne({ username });
  }

  return [...memoryUsers.values()].find((user) => user.username === username) || null;
};

const getAllUsers = async () => {
  if (mongoReady) {
    const users = await User.find({}).sort({ displayName: 1 });
    return users.map((user) => ({
      ...sanitizeUser(user.toObject()),
      online: onlineUsers.has(String(user._id))
    }));
  }

  return [...memoryUsers.values()]
    .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)))
    .map((user) => ({
      ...sanitizeUser(user),
      online: onlineUsers.has(String(user._id))
    }));
};

const createUserRecord = async (payload) => {
  if (mongoReady) {
    const newUser = new User(payload);
    return newUser.save();
  }

  const user = {
    _id: createMemoryId(),
    username: payload.username,
    displayName: payload.displayName,
    passwordHash: payload.passwordHash,
    email: payload.email || '',
    profile: payload.profile || '',
    avatar: payload.avatar || '',
    createdAt: new Date(),
    lastSeen: new Date(),
    online: false
  };

  memoryUsers.set(String(user._id), user);
  return user;
};

const deleteUserRecord = async (userId) => {
  if (mongoReady) {
    await User.findByIdAndDelete(userId);
    await FriendRequest.deleteMany({
      $or: [
        { senderId: userId },
        { receiverId: userId }
      ]
    });
    return;
  }

  memoryUsers.delete(String(userId));

  for (let index = memoryFriendRequests.length - 1; index >= 0; index -= 1) {
    const request = memoryFriendRequests[index];
    if (String(request.senderId) === String(userId) || String(request.receiverId) === String(userId)) {
      memoryFriendRequests.splice(index, 1);
    }
  }
};

const setMemoryPresence = async (userId, online) => {
  if (mongoReady) {
    return;
  }

  const user = memoryUsers.get(String(userId));
  if (!user) {
    return;
  }

  user.lastSeen = new Date();
  user.online = online;
  memoryUsers.set(String(userId), user);
};

const getFriendPayload = async (userId) => {
  if (mongoReady) {
    const requests = await FriendRequest.find({
      $or: [
        { senderId: userId },
        { receiverId: userId }
      ]
    })
      .sort({ createdAt: -1 })
      .populate('senderId', 'username displayName online')
      .populate('receiverId', 'username displayName online');

    const acceptedIds = new Set();
    const incomingRequests = [];
    const outgoingRequests = [];

    requests.forEach((request) => {
      const senderDoc = request.senderId && typeof request.senderId.toObject === 'function'
        ? request.senderId.toObject()
        : request.senderId;
      const receiverDoc = request.receiverId && typeof request.receiverId.toObject === 'function'
        ? request.receiverId.toObject()
        : request.receiverId;

      if (!senderDoc || !receiverDoc) {
        return;
      }

      const senderId = String(senderDoc._id || request.senderId);
      const receiverId = String(receiverDoc._id || request.receiverId);

      if (request.status === 'accepted') {
        const friendId = senderId === userId ? receiverId : senderId;
        acceptedIds.add(friendId);
        return;
      }

      if (senderId === userId) {
        outgoingRequests.push({
          _id: request._id,
          status: request.status,
          createdAt: request.createdAt,
          user: sanitizeUser(receiverDoc)
        });
        return;
      }

      incomingRequests.push({
        _id: request._id,
        status: request.status,
        createdAt: request.createdAt,
        user: sanitizeUser(senderDoc)
      });
    });

    const acceptedUsers = await User.find({ _id: { $in: [...acceptedIds] } }).sort({ displayName: 1 });

    return {
      acceptedUsers: acceptedUsers.map((user) => ({
        ...sanitizeUser(user.toObject()),
        online: onlineUsers.has(String(user._id))
      })),
      incomingRequests,
      outgoingRequests
    };
  }

  const requests = [...memoryFriendRequests]
    .filter((request) => request.senderId === userId || request.receiverId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const acceptedIds = new Set();
  const incomingRequests = [];
  const outgoingRequests = [];

  requests.forEach((request) => {
    const senderId = String(request.senderId);
    const receiverId = String(request.receiverId);

    if (request.status === 'accepted') {
      const friendId = senderId === userId ? receiverId : senderId;
      acceptedIds.add(friendId);
      return;
    }

    if (senderId === userId) {
      outgoingRequests.push({
        _id: request._id,
        status: request.status,
        createdAt: request.createdAt,
        user: sanitizeUser(memoryUsers.get(String(receiverId)) || { _id: receiverId })
      });
      return;
    }

    incomingRequests.push({
      _id: request._id,
      status: request.status,
      createdAt: request.createdAt,
      user: sanitizeUser(memoryUsers.get(String(senderId)) || { _id: senderId })
    });
  });

  const acceptedUsers = [...memoryUsers.values()]
    .filter((user) => acceptedIds.has(String(user._id)))
    .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)))
    .map((user) => ({
      ...sanitizeUser(user),
      online: onlineUsers.has(String(user._id))
    }));

  return {
    acceptedUsers,
    incomingRequests,
    outgoingRequests
  };
};

const areUsersFriends = async (userIdA, userIdB) => {
  if (mongoReady) {
    const request = await FriendRequest.findOne({
      status: 'accepted',
      $or: [
        { senderId: userIdA, receiverId: userIdB },
        { senderId: userIdB, receiverId: userIdA }
      ]
    });

    return Boolean(request);
  }

  return memoryFriendRequests.some((request) => {
    const accepted = request.status === 'accepted';
    return accepted && (
      (String(request.senderId) === String(userIdA) && String(request.receiverId) === String(userIdB)) ||
      (String(request.senderId) === String(userIdB) && String(request.receiverId) === String(userIdA))
    );
  });
};

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }

  req.user = decoded;
  next();
};

const getUserList = async () => {
  if (!mongoReady) {
    return getAllUsers();
  }

  const users = await User.find({}).sort({ displayName: 1 });
  return users.map((user) => ({
    ...sanitizeUser(user.toObject()),
    online: onlineUsers.has(String(user._id))
  }));
};

const emitUsersList = async () => {
  const users = await getUserList();
  io.emit('users:list', { users });
};

const setUserOnline = async (userId, socketId) => {
  if (!mongoReady) {
    const user = memoryUsers.get(String(userId));
    if (!user) return;

    onlineUsers.set(String(userId), { socketId, username: user.username });
    user.lastSeen = new Date();
    user.online = true;
    memoryUsers.set(String(userId), user);

    await emitUsersList();
    return;
  }

  const user = await User.findById(userId);
  if (!user) return;

  onlineUsers.set(String(userId), { socketId, username: user.username });
  user.lastSeen = new Date();
  user.online = true;
  await user.save();

  await emitUsersList();
};

const setUserOffline = async (userId) => {
  if (!mongoReady) {
    const user = memoryUsers.get(String(userId));
    if (!user) return;

    onlineUsers.delete(String(userId));
    user.lastSeen = new Date();
    user.online = false;
    memoryUsers.set(String(userId), user);

    await emitUsersList();
    return;
  }

  const user = await User.findById(userId);
  if (!user) return;

  onlineUsers.delete(String(userId));
  user.lastSeen = new Date();
  user.online = false;
  await user.save();

  await emitUsersList();
};

app.get('/health', (req, res) => {
  res.json({ ok: true, mongoReady });
});

app.get('/', (req, res) => {
  res.json({ service: 'Sigma backend', ok: true, mongoReady });
});

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try {
    const { username, displayName, password, confirmPassword, email, profile } = req.body;

    if (!username || !displayName || !password) {
      return res.status(400).json({ message: 'Username, display name, and password are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match.' });
    }

    const normalizedUsername = username.trim().toLowerCase();
    const existingUser = mongoReady
      ? await User.findOne({ username: normalizedUsername })
      : [...memoryUsers.values()].find((user) => user.username === normalizedUsername);

    if (existingUser) {
      return res.status(409).json({ message: 'Username is already taken.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const saved = mongoReady
      ? await createUserRecord({
          username: normalizedUsername,
          displayName: displayName.trim(),
          passwordHash,
          email: (email || '').trim(),
          profile: normalizeText(profile),
          online: false
        })
      : await createUserRecord({
          username: normalizedUsername,
          displayName: displayName.trim(),
          passwordHash,
          email: (email || '').trim(),
          profile: normalizeText(profile),
          online: false
        });

    const token = createToken(saved);

    res.status(201).json({
      token,
      user: sanitizeUser(saved.toObject ? saved.toObject() : saved)
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ message: 'Unable to create account.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required.' });
    }

    const normalizedUsername = username.trim().toLowerCase();
    const user = mongoReady
      ? await User.findOne({ username: normalizedUsername })
      : [...memoryUsers.values()].find((entry) => entry.username === normalizedUsername);

    if (!user) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    if (mongoReady) {
      user.lastSeen = new Date();
      await user.save();
    } else {
      user.lastSeen = new Date();
      user.online = false;
      memoryUsers.set(String(user._id), user);
    }

    const token = createToken(user);

    res.json({
      token,
      user: sanitizeUser(user.toObject ? user.toObject() : user)
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Unable to log in.' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ user: sanitizeUser(user.toObject ? user.toObject() : user) });
  } catch (error) {
    console.error('Me error:', error);
    res.status(500).json({ message: 'Unable to fetch user.' });
  }
});

app.patch('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const displayName = normalizeText(req.body.displayName).slice(0, 80);
    const profile = normalizeText(req.body.profile).slice(0, 500);
    const avatar = typeof req.body.avatar === 'string' && req.body.avatar.startsWith('data:image/')
      ? req.body.avatar.slice(0, 500000)
      : '';

    if (!displayName) {
      return res.status(400).json({ message: 'Display name is required.' });
    }

    user.displayName = displayName;
    user.profile = profile;
    user.avatar = avatar;

    if (mongoReady) {
      await user.save();
    } else {
      memoryUsers.set(String(user._id), user);
    }

    res.json({ user: sanitizeUser(user.toObject ? user.toObject() : user) });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ message: 'Unable to update profile.' });
  }
});

app.delete('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await getUserById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const onlineEntry = onlineUsers.get(String(userId));
    if (onlineEntry?.socketId) {
      const socket = io.sockets.sockets.get(onlineEntry.socketId);
      if (socket) {
        socket.disconnect(true);
      }
    }

    onlineUsers.delete(String(userId));
    activeTypingUsers.delete(String(userId));

    for (const [key, typingUsersList] of activeTypingUsers.entries()) {
      const updated = typingUsersList.filter((id) => id !== userId);
      if (updated.length) {
        activeTypingUsers.set(key, updated);
      } else {
        activeTypingUsers.delete(key);
      }
    }

    for (const key of [...activeChats.keys()]) {
      if (key.includes(userId)) {
        activeChats.delete(key);
      }
    }

    await deleteUserRecord(userId);
    await emitUsersList();

    res.json({ message: 'Account deleted successfully.' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ message: 'Unable to delete account.' });
  }
});

app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json({ users });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ message: 'Unable to load users.' });
  }
});

app.get('/api/friends', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const payload = await getFriendPayload(userId);
    res.json(payload);
  } catch (error) {
    console.error('Get friends error:', error);
    res.status(500).json({ message: 'Unable to load friends.' });
  }
});

app.post('/api/friends/request', authMiddleware, async (req, res) => {
  try {
    const { targetUserId } = req.body;
    const currentUserId = req.user.id;

    if (!targetUserId || targetUserId === currentUserId) {
      return res.status(400).json({ message: 'Invalid friend request target.' });
    }

    const targetUser = await getUserById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (mongoReady) {
      const existingRequest = await FriendRequest.findOne({
        $or: [
          { senderId: currentUserId, receiverId: targetUserId },
          { senderId: targetUserId, receiverId: currentUserId }
        ]
      });

      if (existingRequest) {
        return res.status(409).json({ message: 'Friend request already exists.' });
      }

      const request = new FriendRequest({
        senderId: currentUserId,
        receiverId: targetUserId,
        status: 'pending'
      });

      await request.save();
    } else {
      const existingRequest = memoryFriendRequests.some((request) => {
        return (
          (String(request.senderId) === String(currentUserId) && String(request.receiverId) === String(targetUserId)) ||
          (String(request.senderId) === String(targetUserId) && String(request.receiverId) === String(currentUserId))
        );
      });

      if (existingRequest) {
        return res.status(409).json({ message: 'Friend request already exists.' });
      }

      memoryFriendRequests.push({
        _id: createMemoryId(),
        senderId: currentUserId,
        receiverId: targetUserId,
        status: 'pending',
        createdAt: new Date()
      });
    }

    const senderSocketId = onlineUsers.get(String(currentUserId))?.socketId;
    const receiverSocketId = onlineUsers.get(String(targetUserId))?.socketId;

    if (senderSocketId) {
      io.to(senderSocketId).emit('friends:update', { type: 'request' });
    }

    if (receiverSocketId) {
      io.to(receiverSocketId).emit('friends:update', { type: 'request' });
    }

    res.status(201).json({ message: 'Friend request sent.' });
  } catch (error) {
    console.error('Send friend request error:', error);
    res.status(500).json({ message: 'Unable to send friend request.' });
  }
});

app.post('/api/friends/accept', authMiddleware, async (req, res) => {
  try {
    const { requestId } = req.body;
    const currentUserId = req.user.id;

    let request;

    if (mongoReady) {
      request = await FriendRequest.findById(requestId);
      if (!request) {
        return res.status(404).json({ message: 'Friend request not found.' });
      }

      if (String(request.receiverId) !== currentUserId) {
        return res.status(403).json({ message: 'You cannot accept this request.' });
      }

      request.status = 'accepted';
      await request.save();
    } else {
      request = memoryFriendRequests.find((item) => String(item._id) === String(requestId));
      if (!request) {
        return res.status(404).json({ message: 'Friend request not found.' });
      }

      if (String(request.receiverId) !== currentUserId) {
        return res.status(403).json({ message: 'You cannot accept this request.' });
      }

      request.status = 'accepted';
    }

    const senderSocketId = onlineUsers.get(String(request.senderId))?.socketId;
    const receiverSocketId = onlineUsers.get(String(request.receiverId))?.socketId;

    if (senderSocketId) {
      io.to(senderSocketId).emit('friends:update', { type: 'accept' });
    }

    if (receiverSocketId) {
      io.to(receiverSocketId).emit('friends:update', { type: 'accept' });
    }

    res.json({ message: 'Friend request accepted.' });
  } catch (error) {
    console.error('Accept friend request error:', error);
    res.status(500).json({ message: 'Unable to accept request.' });
  }
});

app.get('/api/users/search', authMiddleware, async (req, res) => {
  try {
    const query = (req.query.q || '').trim().toLowerCase();

    if (!query) {
      return res.status(400).json({ message: 'Search query is required.' });
    }

    const users = mongoReady
      ? await User.find({
          $or: [
            { username: { $regex: query, $options: 'i' } },
            { displayName: { $regex: query, $options: 'i' } }
          ]
        }).sort({ displayName: 1 })
      : [...memoryUsers.values()].filter((user) => {
          return (
            user.username.toLowerCase().includes(query) ||
            user.displayName.toLowerCase().includes(query)
          );
        }).sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));

    res.json({
      users: users.map((user) => ({
        ...sanitizeUser(user.toObject ? user.toObject() : user),
        online: onlineUsers.has(String(user._id))
      }))
    });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ message: 'Unable to search users.' });
  }
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Authentication required.'));
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return next(new Error('Invalid or expired token.'));
  }

  socket.user = decoded;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.user.id;

  socket.on('chat:open', async ({ targetUserId }) => {
    if (!targetUserId) {
      socket.emit('error', { message: 'Invalid chat target.' });
      return;
    }

    const targetUser = await getUserById(targetUserId);
    if (!targetUser) {
      socket.emit('error', { message: 'User not found.' });
      return;
    }

    const isFriend = await areUsersFriends(userId, targetUserId);
    if (!isFriend) {
      socket.emit('error', { message: 'Chat is only available with accepted friends.' });
      return;
    }

    const conversationKey = [userId, targetUserId].sort().join(':');
    const currentMessages = activeChats.get(conversationKey) || [];
    socket.emit('chat:open', {
      user: sanitizeUser(targetUser.toObject ? targetUser.toObject() : targetUser),
      messages: currentMessages
    });
  });

  socket.on('chat:close', ({ targetUserId }) => {
    if (!targetUserId) return;

    const conversationKey = [userId, targetUserId].sort().join(':');
    activeChats.delete(conversationKey);

    const typingList = activeTypingUsers.get(String(userId)) || [];
    const updatedTypingList = typingList.filter((id) => id !== targetUserId);
    activeTypingUsers.set(String(userId), updatedTypingList);
  });

  socket.on('call:offer', ({ receiverId, offer, callType }) => {
    if (!receiverId || !offer) return;

    const receiverSocketId = onlineUsers.get(String(receiverId))?.socketId;
    if (!receiverSocketId) {
      socket.emit('error', { message: 'User is offline.' });
      return;
    }

    io.to(receiverSocketId).emit('call:incoming', {
      fromUserId: userId,
      offer,
      callType
    });
  });

  socket.on('call:answer', ({ receiverId, answer }) => {
    if (!receiverId || !answer) return;

    const receiverSocketId = onlineUsers.get(String(receiverId))?.socketId;
    if (!receiverSocketId) return;

    io.to(receiverSocketId).emit('call:answer', {
      fromUserId: userId,
      answer
    });
  });

  socket.on('call:ice-candidate', ({ receiverId, candidate }) => {
    if (!receiverId || !candidate) return;

    const receiverSocketId = onlineUsers.get(String(receiverId))?.socketId;
    if (!receiverSocketId) return;

    io.to(receiverSocketId).emit('call:ice-candidate', {
      fromUserId: userId,
      candidate
    });
  });

  socket.on('call:hangup', ({ receiverId }) => {
    if (!receiverId) return;

    const receiverSocketId = onlineUsers.get(String(receiverId))?.socketId;
    if (!receiverSocketId) return;

    io.to(receiverSocketId).emit('call:hangup', {
      fromUserId: userId
    });
  });

  socket.on('message:send', async ({ receiverId, message, type }) => {
    if (!receiverId || !message) {
      socket.emit('error', { message: 'Message cannot be empty.' });
      return;
    }

    const rawMessage = typeof message === 'string' ? message : '';
    const isImage = type === 'image' || rawMessage.startsWith('data:image/');
    const sanitizedText = isImage ? rawMessage : normalizeText(rawMessage);

    if (!sanitizedText) {
      socket.emit('error', { message: 'Message cannot be empty.' });
      return;
    }

    if (!isImage && sanitizedText.length > 2000) {
      socket.emit('error', { message: 'Message too long. Maximum 2000 characters.' });
      return;
    }

    const receiver = await getUserById(receiverId);
    if (!receiver) {
      socket.emit('error', { message: 'User not found.' });
      return;
    }

    const isFriend = await areUsersFriends(userId, receiverId);
    if (!isFriend) {
      socket.emit('error', { message: 'Chat is only available with accepted friends.' });
      return;
    }

    const conversationKey = [userId, receiverId].sort().join(':');
    const tempMessage = {
      temporaryId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      senderId: userId,
      receiverId,
      text: sanitizedText,
      type: isImage ? 'image' : 'text',
      timestamp: new Date().toISOString()
    };

    const currentMessages = activeChats.get(conversationKey) || [];
    activeChats.set(conversationKey, [...currentMessages, tempMessage]);

    const senderSocketId = onlineUsers.get(String(userId))?.socketId;
    const receiverSocketId = onlineUsers.get(String(receiverId))?.socketId;
    const senderUser = await getUserById(userId);
    const sender = sanitizeUser(senderUser.toObject ? senderUser.toObject() : senderUser);

    if (senderSocketId) {
      io.to(senderSocketId).emit('message:receive', {
        message: tempMessage,
        sender
      });
    }

    if (receiverSocketId) {
      io.to(receiverSocketId).emit('message:receive', {
        message: tempMessage,
        sender
      });
    }
  });

  socket.on('typing:start', ({ receiverId }) => {
    if (!receiverId) return;

    const receiverSocketId = onlineUsers.get(String(receiverId))?.socketId;
    if (!receiverSocketId) return;

    const typingMap = activeTypingUsers.get(String(receiverId)) || [];
    if (!typingMap.includes(userId)) {
      typingMap.push(userId);
      activeTypingUsers.set(String(receiverId), typingMap);
    }

    io.to(receiverSocketId).emit('typing:update', {
      typingUsers: typingMap
    });
  });

  socket.on('typing:stop', ({ receiverId }) => {
    if (!receiverId) return;

    const typingMap = activeTypingUsers.get(String(receiverId)) || [];
    const updated = typingMap.filter((id) => id !== userId);
    activeTypingUsers.set(String(receiverId), updated);

    const receiverSocketId = onlineUsers.get(String(receiverId))?.socketId;
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('typing:update', {
        typingUsers: updated
      });
    }
  });

  socket.on('disconnect', async () => {
    await setUserOffline(userId);
    for (const key of [...activeChats.keys()]) {
      if (key.split(':').includes(String(userId))) {
        activeChats.delete(key);
      }
    }
    const receiverTypingLists = [...activeTypingUsers.entries()];
    for (const [receiverId, typingList] of receiverTypingLists) {
      const updated = typingList.filter((id) => id !== userId);
      if (updated.length) {
        activeTypingUsers.set(receiverId, updated);
      } else {
        activeTypingUsers.delete(receiverId);
      }
    }
  });

  (async () => {
    await setUserOnline(userId, socket.id);
  })();
});

const startServer = async () => {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000
    });
    mongoReady = true;
    console.log('MongoDB connected');
  } catch (error) {
    console.warn('MongoDB unavailable, starting fallback local mode:', error.message);
    mongoReady = false;
  }

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT} (mongoReady=${mongoReady})`);
  });
};

startServer();
