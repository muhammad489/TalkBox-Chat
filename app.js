const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const session = require('express-session');
const sharedSession = require('express-socket.io-session');

function ensureAuthenticated(req, res, next) {
  if (req.session.username) {
      return next();  
  } else {
      res.redirect('/login');  
  }
}

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

const sessionMiddleware = session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true
});

app.use(sessionMiddleware);

// Share session with Socket.io
io.use(sharedSession(sessionMiddleware, {
  autoSave: true
}));

const db = mysql.createConnection({
  host: '192.168.0.244',
  user: 'root',
  password: 'a@@@@@@@@@@',
  database: 'chatlogin'
});

db.connect((err) => {
  if (err) {
    console.error('Error connecting to database:', err);
    return;
  }
  console.log('Connected to database');
});

let roomUsers = {};

app.get('/', (req, res) => {
  if (req.session.username) {
    res.redirect('/chat');
  } else {
    res.redirect('/login');
  }
});

app.get('/login', (req, res) => {
  res.sendFile(__dirname + '/login.html');
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.query("SELECT * FROM users WHERE username=? AND password=?", [username, password], (err, results) => {
    if (err) {
      console.error(err);
      res.status(500).send('Error logging in');
    } else if (results.length > 0) {
      req.session.username = username;
      res.redirect('/chat');
    } else {
      res.send('Invalid credentials');
    }
  });
});

app.get('/register', (req, res) => {
  res.sendFile(__dirname + '/register.html');
});

app.post('/register', (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = bcrypt.hashSync(password, 10);
  db.query("INSERT INTO users (username, password) VALUES (?, ?)", [username, hashedPassword], (err) => {
    if (err) {
      console.error(err);
      res.status(500).send('Error registering user');
    } else {
      res.redirect('/login');
    }
  });
});

app.get('/chat', (req, res) => {
  if (!req.session.username) {
    res.redirect('/login');
  } else {
    res.render('chat', { username: req.session.username });
  }
});

app.get('/chat', ensureAuthenticated, (req, res) => {
  res.sendFile(__dirname + '/chat.html');
});

app.post('/logout', (req, res) => {
  req.session.destroy(err => {
      if (err) {
          return res.redirect('/chat');  
      }
      res.clearCookie('connect.sid'); 
      res.redirect('/login');  
  });
});

io.on('connection', (socket) => {
  console.log('New connection');
  socket.on('disconnect', () => {
    const username = socket.handshake.session.username;
    if (username) {
      const currentRoom = socket.handshake.session.currentRoom;
      if (currentRoom) {
        if (roomUsers[currentRoom].includes(username)) {
          roomUsers[currentRoom].splice(roomUsers[currentRoom].indexOf(username), 1);
          io.to(currentRoom).emit('status', { msg: `${username} has left the room.` });
          io.to(currentRoom).emit('updateUsers', { users: roomUsers[currentRoom] });
        }
        socket.handshake.session.currentRoom = null;
      }
    }
  });

  socket.on('createRoom', (data) => {
    const { roomID, roomName, roomPassword } = data;
    console.log(`Creating room: ${roomID} with name: ${roomName}`);

    const hashedRoomPassword = bcrypt.hashSync(roomPassword, 10);
    console.log('Hashed room password:', hashedRoomPassword);

    db.query("INSERT INTO rooms (room_id, room_name, room_password) VALUES (?, ?, ?)", [roomID, roomName, hashedRoomPassword], (err) => {
        if (err) {
            console.error('Error creating room:', err);
            socket.emit('roomCreated', { success: false });
        } else {
            roomUsers[roomID] = [];
            socket.emit('roomCreated', { roomID, roomName, success: true });  
        }
    });
});

socket.on('roomCreated', (data) => {
  if (data.success) {
      appendMessage('System', `Room "${data.roomName}" created with ID "${data.roomID}".`, 'received', '');
  } else {
      alert('Room creation failed. Please try again.');
  }
});

  socket.on('joinRoom', (data) => {
    const { roomID, password } = data;
    console.log(`Attempting to join room: ${roomID} with password: ${password}`);

    db.query("SELECT room_password FROM rooms WHERE room_id=?", [roomID], (err, results) => {
        if (err) {
            console.error('Database query error:', err);
            socket.emit('status', { msg: 'Invalid room ID or password.' });
        } else if (results.length === 0) {
            console.log('No room found with the provided room ID');
            socket.emit('status', { msg: 'Invalid room ID or password.' });
        } else {
            const hashedRoomPassword = results[0].room_password;
            console.log('Hashed room password from DB:', hashedRoomPassword);
            const passwordMatches = bcrypt.compareSync(password, hashedRoomPassword);
            console.log('Password matches:', passwordMatches);

            if (passwordMatches) {
                socket.join(roomID);
                if (!roomUsers[roomID]) {
                    roomUsers[roomID] = [];
                }
                roomUsers[roomID].push(socket.handshake.session.username);
                socket.handshake.session.currentRoom = roomID;
                socket.emit('roomJoined', { roomID });
                io.to(roomID).emit('status', { msg: `${socket.handshake.session.username} has joined the room.` });
                io.to(roomID).emit('updateUsers', { users: roomUsers[roomID] });
            } else {
                console.log('Password does not match');
                socket.emit('status', { msg: 'Invalid room ID or password.' });
            }
        }
    });
});

  socket.on('leaveRoom', (data) => {
    const roomID = data.roomID;
    const username = socket.handshake.session.username;
    socket.leave(roomID);
    if (roomUsers[roomID].includes(username)) {
      roomUsers[roomID].splice(roomUsers[roomID].indexOf(username), 1);
      socket.emit('status', { msg: `${username} has left the room.` }, roomID);
      socket.emit('updateUsers', { users: roomUsers[roomID] }, roomID);
    }
    if (socket.handshake.session.currentRoom === roomID) {
      socket.handshake.session.currentRoom = null;
    }
  });

  socket.on('sendMessage', (data) => {
    const roomID = data.roomID;
    const message = data.message;
    const username = socket.handshake.session.username;
    const timestamp = new Date().toISOString();

    socket.broadcast.to(roomID).emit('receiveMessage', { msg: message, user: username, timestamp });

});

});

server.listen(5000, '0.0.0.0', () => {
  console.log('Server listening on port 5000');
});

