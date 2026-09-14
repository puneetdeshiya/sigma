# Real-Time Chat App

A complete, mobile-first real-time chat web application with:

- React + Vite frontend
- Express + Socket.IO backend
- MongoDB Atlas for persistent user/account data only
- Temporary in-memory chat messages only
- JWT authentication
- User search, online status, typing indicators, and private messaging
- Responsive UI for desktop and mobile

## Important Architecture Note

This app stores user accounts in MongoDB Atlas, but it does NOT store chat history in MongoDB or any other permanent database. All chat messages exist only in server memory while the relevant chat sessions are active. A server restart clears all temporary messages.

## Tech Stack

- Frontend: React, Vite, Socket.IO client
- Backend: Node.js, Express, Socket.IO
- Database: MongoDB Atlas (Mongoose)
- Authentication: JWT + bcryptjs
- Security: Helmet, CORS, express-rate-limit

## Project Structure

chat-app/

├── client/
│   ├── src/
│   ├── package.json
│   ├── vite.config.js
│   └── index.html
├── server/
│   ├── src/
│   ├── package.json
│   └── .env.example
├── .gitignore
├── package.json
├── README.md
└── .env.example

## Prerequisites

- Node.js 18+
- npm
- MongoDB Atlas account (free M0)
- GitHub account

## Local Setup

1. Clone the repository
2. Install root dependencies:

   npm install

3. Install client dependencies:

   npm run install:client

4. Install server dependencies:

   npm run install:server

5. Create environment files:

   - Copy `.env.example` to `.env` in the root (optional if using one env file)
   - Copy `server/.env.example` to `server/.env`

6. Fill in environment variables in `server/.env`.

7. Start the app in development mode:

   npm run dev

This runs the backend on port 5000 and the frontend on port 5173.

## Environment Variables

### Server

Create `server/.env` using `server/.env.example`.

Example:

PORT=5000
MONGODB_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/chat-app
JWT_SECRET=your_jwt_secret_here
CLIENT_URL=http://localhost:5173
NODE_ENV=development

## MongoDB Atlas Setup

1. Create a MongoDB Atlas account.
2. Create a free M0 cluster.
3. Create a database user with read/write access.
4. Configure network access for your IP address.
5. Get your MongoDB connection string.
6. Replace the password in the connection string and save it in `server/.env`.
7. Never commit `.env` files to GitHub.

## Running the App

### Development

npm run dev

### Production Build

npm run build

### Production Server

npm start

## API Endpoints

- POST /api/auth/signup
- POST /api/auth/login
- GET /api/auth/me
- GET /api/users
- GET /api/users/search

## Real-Time Socket Events

The server provides Socket.IO events for authentication, user status, chat messages, and typing indicators.

## Deployment

### Frontend

- Deploy the `client` build to Vercel or Netlify.
- Set `VITE_API_URL` and `VITE_SOCKET_URL` in the hosting environment.

### Backend

- Deploy the Express + Socket.IO server to Render, Railway, Fly.io, or similar.
- Set environment variables in the hosting platform.

### Database

- Use MongoDB Atlas M0 cluster.

## Security Notes

- Passwords are hashed with bcrypt.
- JWTs are required for protected API routes and socket connections.
- Message content is basic sanitized on the client and server side.
- Rate limiting is enabled for auth endpoints.

## Troubleshooting

### MongoDB connection issues

- Check your Atlas cluster status.
- Verify the database user and IP whitelist.
- Confirm the connection string is correct.

### Socket connection issues

- Ensure the frontend uses the correct socket server URL.
- Check that the JWT token is valid.

### Authentication errors

- Verify the JWT secret matches on the backend.
- Remove expired tokens and log in again.

## GitHub Setup

1. Initialize a Git repository.
2. Commit your project.
3. Create a remote repository on GitHub.
4. Push your code.
5. Add `.env` files locally only, never to GitHub.

## License

This project is provided as-is for educational and demonstration purposes.
