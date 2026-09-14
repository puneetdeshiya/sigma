import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

const sanitizeText = (value) => {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const getStoredToken = () => localStorage.getItem('chat-token');

const getUserForSession = () => {
  try {
    const raw = localStorage.getItem('chat-user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const setUserForSession = (user) => {
  localStorage.setItem('chat-user', JSON.stringify(user));
};

const formatTime = (timestamp) => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  });
};

const initialForms = {
  login: {
    username: '',
    password: ''
  },
  signup: {
    username: '',
    displayName: '',
    password: '',
    confirmPassword: '',
    email: '',
    profile: ''
  }
};

function App() {
  const [view, setView] = useState('login');
  const [authUser, setAuthUser] = useState(getUserForSession());
  const [token, setToken] = useState(getStoredToken());
  const [form, setForm] = useState(initialForms);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState([]);
  const [friends, setFriends] = useState({
    acceptedUsers: [],
    incomingRequests: [],
    outgoingRequests: []
  });
  const [selectedUser, setSelectedUser] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [messageText, setMessageText] = useState('');
  const [messages, setMessages] = useState([]);
  const [conversationMap, setConversationMap] = useState({});
  const [typingUsers, setTypingUsers] = useState([]);
  const [isMobileChatOpen, setIsMobileChatOpen] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [callState, setCallState] = useState({
    status: 'idle',
    remoteUser: null,
    incomingCall: null,
    type: 'audio'
  });
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const filteredUsers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return users;
    return users.filter((user) => {
      return (
        user.username.toLowerCase().includes(query) ||
        user.displayName.toLowerCase().includes(query)
      );
    });
  }, [searchQuery, users]);

  const currentUser = authUser;

  const stopStreamTracks = (stream) => {
    stream?.getTracks()?.forEach((track) => track.stop());
  };

  const cleanupCallSession = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
      stopStreamTracks(localStreamRef.current);
      localStreamRef.current = null;
    }

    setLocalStream(null);
    setRemoteStream(null);
    setCallState({
      status: 'idle',
      remoteUser: null,
      incomingCall: null,
      type: 'audio'
    });
  };

  const requestLocalStream = async (callType = 'audio') => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not support media calls.');
    }

    if (localStreamRef.current) {
      return localStreamRef.current;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video'
    });

    localStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  };

  const createPeerConnection = async (remoteUserId) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('call:ice-candidate', {
          receiverId: remoteUserId,
          candidate: event.candidate
        });
      }
    };

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanupCallSession();
      }
    };

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    peerConnectionRef.current = pc;
    return pc;
  };

  const startCall = async (user, callType = 'audio') => {
    try {
      const stream = await requestLocalStream(callType);
      const pc = await createPeerConnection(user._id);
      setCallState({
        status: 'calling',
        remoteUser: user,
        incomingCall: null,
        type: callType
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socketRef.current.emit('call:offer', {
        receiverId: user._id,
        offer,
        callType
      });

      setLocalStream(stream);
    } catch (error) {
      setErrors({ api: error.message || 'Unable to start call.' });
    }
  };

  const acceptIncomingCall = async () => {
    if (!callState.incomingCall || !socketRef.current) return;

    try {
      const stream = await requestLocalStream(callState.incomingCall.callType);
      const pc = await createPeerConnection(callState.incomingCall.fromUserId);
      setCallState({
        status: 'connecting',
        remoteUser: callState.incomingCall.fromUser,
        incomingCall: null,
        type: callState.incomingCall.callType
      });

      await pc.setRemoteDescription(new RTCSessionDescription(callState.incomingCall.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socketRef.current.emit('call:answer', {
        receiverId: callState.incomingCall.fromUserId,
        answer
      });

      setLocalStream(stream);
    } catch (error) {
      setErrors({ api: error.message || 'Unable to accept call.' });
    }
  };

  const hangUpCall = () => {
    if (socketRef.current && callState.remoteUser?._id) {
      socketRef.current.emit('call:hangup', {
        receiverId: callState.remoteUser._id
      });
    }

    cleanupCallSession();
  };

  useEffect(() => {
    const verifySession = async () => {
      if (!token) return;
      try {
        const response = await fetch(`${API_URL}/api/auth/me`, {
          headers: {
            Authorization: `Bearer ${token}`
          }
        });

        if (!response.ok) {
          throw new Error('Session expired');
        }

        const data = await response.json();
        setAuthUser(data.user);
        setUserForSession(data.user);
        setView('chat');
      } catch {
        localStorage.removeItem('chat-token');
        localStorage.removeItem('chat-user');
        setToken(null);
        setAuthUser(null);
        setView('login');
      }
    };

    verifySession();
  }, [token]);

  useEffect(() => {
    if (!authUser || !token) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setSocketConnected(false);
      setUsers([]);
      setSelectedUser(null);
      setMessages([]);
      return;
    }

    const newSocket = io(SOCKET_URL, {
      auth: {
        token
      },
      transports: ['websocket']
    });

    socketRef.current = newSocket;

    newSocket.on('connect', () => {
      setSocketConnected(true);
    });

    newSocket.on('disconnect', () => {
      setSocketConnected(false);
    });

    newSocket.on('users:list', (payload) => {
      setUsers(payload.users || []);
    });

    newSocket.on('message:receive', (payload) => {
      const incoming = payload.message;
      const peerId = incoming.senderId === currentUser?._id ? incoming.receiverId : incoming.senderId;
      const peerUser = users.find((user) => user._id === peerId) || payload.sender || null;

      setConversationMap((prev) => {
        const existing = prev[peerId] || [];
        const exists = existing.some((item) => item.temporaryId === incoming.temporaryId);
        const nextMessages = exists ? existing : [...existing, incoming];

        return {
          ...prev,
          [peerId]: nextMessages
        };
      });

      if (peerUser && incoming.senderId !== currentUser?._id) {
        setSelectedUser(peerUser);
        setIsMobileChatOpen(true);
      }
    });

    newSocket.on('typing:update', (payload) => {
      setTypingUsers(payload.typingUsers || []);
    });

    newSocket.on('chat:open', (payload) => {
      const nextMessages = payload.messages || [];
      setConversationMap((prev) => ({
        ...prev,
        [payload.user._id]: nextMessages
      }));
      setMessages(nextMessages);
      setSelectedUser(payload.user);
      setIsMobileChatOpen(true);
    });

    newSocket.on('call:incoming', (payload) => {
      setCallState({
        status: 'incoming',
        remoteUser: payload.fromUser,
        incomingCall: payload,
        type: payload.callType || 'audio'
      });
    });

    newSocket.on('call:answer', async (payload) => {
      if (!peerConnectionRef.current || !payload.answer) return;

      try {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(payload.answer));
        setCallState((prev) => ({ ...prev, status: 'connected' }));
      } catch (error) {
        setErrors({ api: 'Unable to connect the call.' });
      }
    });

    newSocket.on('call:ice-candidate', async (payload) => {
      if (!peerConnectionRef.current || !payload.candidate) return;

      try {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch (error) {
        // Ignore candidate errors during negotiation.
      }
    });

    newSocket.on('call:hangup', () => {
      cleanupCallSession();
    });

    newSocket.on('chat:sync', (payload) => {
      setMessages(payload.messages || []);
    });

    newSocket.on('error', (payload) => {
      setErrors({ api: payload.message || 'Something went wrong.' });
    });

    newSocket.on('connect_error', () => {
      setErrors({ api: 'Socket connection failed. Please refresh or try again.' });
    });

    return () => {
      newSocket.disconnect();
    };
  }, [authUser, token]);

  useEffect(() => {
    if (!authUser || !token) return;
    fetchUsers();
    fetchFriends();
  }, [authUser, token]);

  useEffect(() => {
    if (!selectedUser) {
      setMessages([]);
      return;
    }

    setMessages(conversationMap[selectedUser._id] || []);
  }, [selectedUser, conversationMap]);

  const fetchUsers = async () => {
    try {
      const response = await fetch(`${API_URL}/api/users`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to load users');
      }

      const data = await response.json();
      setUsers(data.users || []);
    } catch (error) {
      setErrors({ api: error.message || 'Unable to load users.' });
    }
  };

  const fetchFriends = async () => {
    try {
      const response = await fetch(`${API_URL}/api/friends`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to load friends');
      }

      const data = await response.json();
      setFriends({
        acceptedUsers: data.acceptedUsers || [],
        incomingRequests: data.incomingRequests || [],
        outgoingRequests: data.outgoingRequests || []
      });
    } catch (error) {
      setErrors({ api: error.message || 'Unable to load friends.' });
    }
  };

  const isFriend = (userId) => friends.acceptedUsers.some((user) => user._id === userId);
  const hasOutgoingRequest = (userId) => friends.outgoingRequests.some((request) => request.user._id === userId);
  const hasIncomingRequest = (userId) => friends.incomingRequests.some((request) => request.user._id === userId);

  const handleSendFriendRequest = async (userId) => {
    try {
      const response = await fetch(`${API_URL}/api/friends/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ targetUserId: userId })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Unable to send friend request.');
      }

      await fetchFriends();
    } catch (error) {
      setErrors({ api: error.message || 'Unable to send friend request.' });
    }
  };

  const handleAcceptFriendRequest = async (requestId) => {
    try {
      const response = await fetch(`${API_URL}/api/friends/accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ requestId })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Unable to accept request.');
      }

      await fetchFriends();
    } catch (error) {
      setErrors({ api: error.message || 'Unable to accept request.' });
    }
  };

  const handleAuth = async (type) => {
    setLoading(true);
    setErrors({});

    try {
      const endpoint = type === 'login' ? '/api/auth/login' : '/api/auth/signup';
      const payload = type === 'login'
        ? {
            username: form.login.username,
            password: form.login.password
          }
        : {
            username: form.signup.username,
            displayName: form.signup.displayName,
            password: form.signup.password,
            confirmPassword: form.signup.confirmPassword,
            email: form.signup.email,
            profile: form.signup.profile
          };

      const response = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        const message = data.message || 'Authentication failed';
        throw new Error(message);
      }

      localStorage.setItem('chat-token', data.token);
      setToken(data.token);
      setAuthUser(data.user);
      setUserForSession(data.user);
      setView('chat');
      setForm(initialForms);
    } catch (error) {
      setErrors({ api: error.message || 'Request failed.' });
    } finally {
      setLoading(false);
    }
  };

  const resetSession = () => {
    localStorage.removeItem('chat-token');
    localStorage.removeItem('chat-user');
    setToken(null);
    setAuthUser(null);
    setView('login');
    setSelectedUser(null);
    setMessages([]);
    setTypingUsers([]);
    setSearchQuery('');
    setConversationMap({});
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    cleanupCallSession();
  };

  const handleLogout = () => {
    resetSession();
  };

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  const handleDeleteAccount = async () => {
    const confirmed = window.confirm('Are you sure you want to delete your account? This cannot be undone.');
    if (!confirmed) return;

    try {
      const response = await fetch(`${API_URL}/api/auth/me`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Unable to delete account.');
      }

      resetSession();
      setErrors({ api: data.message || 'Account deleted.' });
    } catch (error) {
      setErrors({ api: error.message || 'Unable to delete account.' });
    }
  };

  const openChat = (user) => {
    if (!isFriend(user._id)) {
      setErrors({ api: 'Chat is only available with accepted friends.' });
      return;
    }

    setSelectedUser(user);
    setIsMobileChatOpen(true);
    const conversation = conversationMap[user._id] || [];
    setMessages(conversation);
    if (socketRef.current) {
      socketRef.current.emit('chat:open', { targetUserId: user._id });
    }
  };

  const handleSendMessage = () => {
    const trimmed = messageText.trim();
    if (!trimmed || !selectedUser || !socketRef.current) return;

    if (!isFriend(selectedUser._id)) {
      setErrors({ api: 'Chat is only available with accepted friends.' });
      return;
    }

    const safeMessage = sanitizeText(trimmed).slice(0, 2000);

    socketRef.current.emit('message:send', {
      receiverId: selectedUser._id,
      message: safeMessage
    });

    setMessageText('');
    socketRef.current.emit('typing:stop', {
      receiverId: selectedUser._id
    });
  };

  const handleTyping = (value) => {
    setMessageText(value);
    if (!selectedUser || !socketRef.current) return;

    if (value.trim()) {
      socketRef.current.emit('typing:start', {
        receiverId: selectedUser._id
      });
    } else {
      socketRef.current.emit('typing:stop', {
        receiverId: selectedUser._id
      });
    }
  };

  const renderAuth = () => (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand-row">
          <div className="brand-badge">C</div>
          <div>
            <h1>ChatFlow</h1>
            <p>Simple real-time messaging</p>
          </div>
        </div>

        {errors.api && <div className="error-box">{errors.api}</div>}

        {view === 'login' ? (
          <>
            <h2>Login</h2>
            <input
              type="text"
              placeholder="Username"
              value={form.login.username}
              onChange={(e) => setForm({
                ...form,
                login: { ...form.login, username: e.target.value }
              })}
            />
            <input
              type="password"
              placeholder="Password"
              value={form.login.password}
              onChange={(e) => setForm({
                ...form,
                login: { ...form.login, password: e.target.value }
              })}
            />
            <button onClick={() => handleAuth('login')} disabled={loading}>
              {loading ? 'Logging in...' : 'Login'}
            </button>
            <p className="auth-toggle">
              Don’t have an account? <button onClick={() => setView('signup')} className="link-button">Sign up</button>
            </p>
          </>
        ) : (
          <>
            <h2>Create account</h2>
            <input
              type="text"
              placeholder="Username"
              value={form.signup.username}
              onChange={(e) => setForm({
                ...form,
                signup: { ...form.signup, username: e.target.value }
              })}
            />
            <input
              type="text"
              placeholder="Display name"
              value={form.signup.displayName}
              onChange={(e) => setForm({
                ...form,
                signup: { ...form.signup, displayName: e.target.value }
              })}
            />
            <input
              type="email"
              placeholder="Email (optional)"
              value={form.signup.email}
              onChange={(e) => setForm({
                ...form,
                signup: { ...form.signup, email: e.target.value }
              })}
            />
            <textarea
              rows="3"
              placeholder="Profile information (optional)"
              value={form.signup.profile}
              onChange={(e) => setForm({
                ...form,
                signup: { ...form.signup, profile: e.target.value }
              })}
            />
            <input
              type="password"
              placeholder="Password"
              value={form.signup.password}
              onChange={(e) => setForm({
                ...form,
                signup: { ...form.signup, password: e.target.value }
              })}
            />
            <input
              type="password"
              placeholder="Confirm password"
              value={form.signup.confirmPassword}
              onChange={(e) => setForm({
                ...form,
                signup: { ...form.signup, confirmPassword: e.target.value }
              })}
            />
            <button onClick={() => handleAuth('signup')} disabled={loading}>
              {loading ? 'Creating account...' : 'Create Account'}
            </button>
            <p className="auth-toggle">
              Already registered? <button onClick={() => setView('login')} className="link-button">Login</button>
            </p>
          </>
        )}
      </div>
    </div>
  );

  const renderChat = () => (
    <div className="app-shell">
      <aside className={`sidebar ${isMobileChatOpen ? 'sidebar-hidden' : ''}`}>
        <div className="sidebar-header">
          <div className="brand-row">
            <div className="brand-badge">C</div>
            <div>
              <h2>ChatFlow</h2>
            </div>
          </div>
          <button className="ghost-button" onClick={handleLogout}>Logout</button>
        </div>

        <div className="profile-card">
          <div className="avatar">{currentUser?.displayName?.[0]?.toUpperCase() || 'U'}</div>
          <div>
            <strong>{currentUser?.displayName}</strong>
            <p>@{currentUser?.username}</p>
          </div>
        </div>

        <button className="danger-button" onClick={handleDeleteAccount}>Delete Account</button>

        <div className="search-box">
          <input
            type="text"
            placeholder="Search users"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="friend-section">
          <h4>Friend Requests</h4>
          {friends.incomingRequests.length === 0 ? (
            <p className="muted-text">No incoming requests</p>
          ) : (
            <div className="mini-list">
              {friends.incomingRequests.map((request) => (
                <div key={request._id} className="mini-item">
                  <span>{request.user.displayName}</span>
                  <button className="accept-button" onClick={() => handleAcceptFriendRequest(request._id)}>Accept</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="user-list">
          {filteredUsers.filter((user) => user._id !== currentUser?._id).map((user) => {
            const friend = isFriend(user._id);
            const outgoing = hasOutgoingRequest(user._id);
            const incoming = hasIncomingRequest(user._id);

            return (
              <div key={user._id} className={`user-row ${selectedUser?._id === user._id ? 'active' : ''}`}>
                <button className="user-button" onClick={() => openChat(user)}>
                  <div className="avatar small">{user.displayName?.[0]?.toUpperCase() || 'U'}</div>
                  <div className="user-info">
                    <div className="row">
                      <strong>{user.displayName}</strong>
                      {user.online ? <span className="online-dot" /> : <span className="offline-dot" />}
                    </div>
                    <span>@{user.username}</span>
                  </div>
                </button>

                {!friend && (
                  <button
                    className="friend-button"
                    onClick={() => handleSendFriendRequest(user._id)}
                    disabled={outgoing || incoming}
                  >
                    {outgoing ? 'Requested' : incoming ? 'Request Received' : 'Add Friend'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      <main className={`chat-panel ${isMobileChatOpen ? 'chat-open' : ''}`}>
        {selectedUser ? (
          <>
            <header className="chat-header">
              <div className="chat-header-left">
                <button
                  className="back-button"
                  onClick={() => setIsMobileChatOpen(false)}
                >
                  ←
                </button>
                <div className="avatar small">{selectedUser.displayName?.[0]?.toUpperCase() || 'U'}</div>
                <div>
                  <h3>{selectedUser.displayName}</h3>
                  <p>{selectedUser.online ? 'Online' : 'Offline'}</p>
                </div>
              </div>

              <div className="chat-actions">
                <button className="small-button" onClick={() => startCall(selectedUser, 'video')}>🎥 Video Call</button>
                <button className="small-button" onClick={() => startCall(selectedUser, 'audio')}>📞 Call</button>
              </div>
            </header>

            {callState.incomingCall && (
              <div className="call-banner">
                <div>
                  <strong>{callState.remoteUser?.displayName}</strong> is calling you ({callState.type})
                </div>
                <div className="call-banner-actions">
                  <button className="accept-button" onClick={acceptIncomingCall}>Accept</button>
                  <button className="ghost-button" onClick={cleanupCallSession}>Decline</button>
                </div>
              </div>
            )}

            {(callState.status !== 'idle' || localStream || remoteStream) && (
              <div className="call-panel">
                <div className="video-grid">
                  <div className="video-box">
                    <video ref={localVideoRef} autoPlay muted playsInline />
                    <span>You</span>
                  </div>
                  {remoteStream && (
                    <div className="video-box">
                      <video ref={remoteVideoRef} autoPlay playsInline />
                      <span>{callState.remoteUser?.displayName || 'Remote User'}</span>
                    </div>
                  )}
                </div>
                <div className="call-panel-actions">
                  <button className="danger-button call-end-button" onClick={hangUpCall}>End Call</button>
                </div>
              </div>
            )}

            <div className="messages">
              {messages.map((msg) => {
                const isMine = msg.senderId === currentUser?._id;
                return (
                  <div key={msg.temporaryId || msg.timestamp} className={`message-row ${isMine ? 'mine' : ''}`}>
                    <div className="message-bubble">
                      <p>{msg.text}</p>
                      <small>{formatTime(msg.timestamp)}</small>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="typing-row">
              {typingUsers.length > 0 && typingUsers.includes(selectedUser._id) ? (
                <span>{selectedUser.displayName} is typing...</span>
              ) : null}
            </div>

            <div className="composer">
              <input
                type="text"
                placeholder="Type a message"
                value={messageText}
                onChange={(e) => handleTyping(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSendMessage();
                  }
                }}
              />
              <button onClick={handleSendMessage}>Send</button>
            </div>
          </>
        ) : (
          <div className="empty-chat">
            <h3>Select a user to start chatting</h3>
          </div>
        )}
      </main>
    </div>
  );

  return (
    <>
      {authUser && token ? renderChat() : renderAuth()}
    </>
  );
}

export default App;
