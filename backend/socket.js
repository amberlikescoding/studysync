/**
 * socket.js — Real-time WebSocket push via Socket.io
 *
 * HOW IT WORKS:
 *   • When the frontend loads, it connects to this Socket.io server
 *   • It sends its userId to join a private "room"
 *   • When Claude finishes processing a batch, we call pushToUser(userId, data)
 *   • Socket.io delivers the data instantly to that user's browser
 *   • The dashboard updates without a page refresh
 *
 * WHY SOCKET.IO:
 *   • Simple API, works on every browser
 *   • Built-in reconnection handling
 *   • Room-based messaging (each user gets their own private channel)
 */

let ioInstance = null;

/**
 * initSocket(httpServer)
 *
 * Called once in server.js to attach Socket.io to the HTTP server.
 * Returns the io instance so server.js can use it.
 */
function initSocket(httpServer) {
  const { Server } = require('socket.io');

  ioInstance = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  ioInstance.on('connection', (socket) => {
    console.log('[socket] Client connected:', socket.id);

    // Frontend sends { userId } to join their private room
    socket.on('join', ({ userId }) => {
      if (userId) {
        socket.join(`user:${userId}`);
        console.log(`[socket] User ${userId} joined their room`);

        // Confirm to frontend that join was successful
        socket.emit('joined', { userId, message: 'Listening for updates...' });
      }
    });

    socket.on('disconnect', () => {
      console.log('[socket] Client disconnected:', socket.id);
    });
  });

  return ioInstance;
}

/**
 * pushToUser(userId, data)
 *
 * Send a real-time event to a specific user's browser.
 * Called from webhook.js after Claude finishes processing a batch.
 *
 * data = { event: 'new_items', count: 3, items: [...] }
 */
function pushToUser(userId, data) {
  if (!ioInstance) {
    console.warn('[socket] Socket.io not initialized yet');
    return;
  }
  ioInstance.to(`user:${userId}`).emit('dashboard_update', data);
  console.log(`[socket] Pushed update to user ${userId}:`, data.event);
}

module.exports = { initSocket, pushToUser };
