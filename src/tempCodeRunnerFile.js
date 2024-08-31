const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);
const mysql = require('mysql');
const bcrypt = require('bcrypt');
const session = require('express-session');

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true
}));

const db = mysql.createConnection({
  host: '127.0.0.1',
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
    res.sendFile(__dirname + '/chat.html');
  }
});

app.post('/logout', (req, res) => {
  const username = req.session.username;
  if (username) {
    const currentRoom = req.session.currentRoom;
    if (currentRoom) {
      if (roomUsers[currentRoom].includes(username)) {
        roomUsers[currentRoom].splice(roomUsers[currentRoom].indexOf(username), 1);
        io.emit('status', { msg: `${username} has left the room.` }, currentRoom);
        io.emit('updateUsers', { users: roomUsers[currentRoom] }, currentRoom);
      }
      req.session.currentRoom = null;
    }
    req.session.username = null;
  }
  res.redirect('/login');
});

io.on('connection', (socket) => {
  console.log('New connection');

  socket.on('disconnect', () => {
    const username = req.session.username;
    if (username) {
      const currentRoom = req.session.currentRoom;
      if (currentRoom) {
        if (roomUsers[currentRoom].includes(username)) {
          roomUsers[currentRoom].splice(roomUsers[currentRoom].indexOf(username), 1);
          io.emit('status', { msg: `${username} has left the room.` }, currentRoom);
          io.emit('updateUsers', { users: roomUsers[currentRoom] }, currentRoom);
        }
        req.session.currentRoom = null;
      }
    }
  });

  socket.on('createRoom', (data) => {
    const { roomID, roomName, roomPassword } = data;
    const hashedRoomPassword = bcrypt.hashSync(roomPassword, 10);
    db.query("INSERT INTO rooms (room_id, room_name, room_password) VALUES (?, ?, ?)", [roomID, roomName, hashedRoomPassword], (err) => {
      if (err) {
        console.error(err);
        socket.emit('roomCreated', { success: false });
      } else {
        roomUsers[roomID] = [];
        socket.emit('roomCreated', { roomID, roomName, success: true }, broadcast: true);
      }
    });
  });

  socket.on('joinRoom', (data) => {
    const { roomID, password } = data;
    db.query("SELECT room_password FROM rooms WHERE room_id=?", [roomID], (err, results) => {
      if (err) {
        console.error(err);
        socket.emit('status', { msg: 'Invalid room ID or password.' });
      } else if (results.length > 0) {
        const hashedRoomPassword = results[0].room_password;
        if (bcrypt.compareSync(password, hashedRoomPassword)) {
          socket.join(roomID);
          if (!roomUsers[roomID]) {
            roomUsers[roomID] = [];
          }
          roomUsers[roomID].push(req.session.username);
          req.session.currentRoom = roomID;
          socket.emit('status', { msg: `${req.session.username} has joined the room.` }, roomID);
          socket.emit('roomJoined', { roomID }, roomID);
          socket.emit('updateUsers', { users: roomUsers[roomID] }, roomID);
        } else {
          socket.emit('status', { msg: 'Invalid room ID or password.' });
        }
      } else {
        socket.emit('status', { msg: 'Invalid room ID or password.' });
      }
    });
  });

  socket.on('leaveRoom', (data) => {
    const roomID = data.roomID;
    const username = req.session.username;
    socket.leave(roomID);
    if (roomUsers[roomID].includes(username)) {
      roomUsers[roomID].splice(roomUsers[roomID].indexOf(username), 1);
      socket.emit('status', { msg: `${username} has left the room.` }, roomID);
      socket.emit('updateUsers', { users: roomUsers[roomID] }, roomID);
    }
    if (req.session.currentRoom === roomID) {
      req.session.currentRoom = null;
    }
  });

  socket.on('sendMessage', (data) => {
    const roomID = data.roomID;
    const message = data.message;
    const username = req.session.username;
    const timestamp = new Date().toISOString();
    socket.emit('receiveMessage', { msg: message, user: username, timestamp }, roomID, { includeSelf: false });
    // Optionally, you can save the message to a database here
  });
});

server.listen(5000, () => {
  console.log('Server listening on port 5000');
});