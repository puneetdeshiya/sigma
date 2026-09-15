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

const formatCallDuration = (seconds) => {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainder = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
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
  const [adminUsers, setAdminUsers] = useState([]);
  const [groups, setGroups] = useState([]);
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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsForm, setSettingsForm] = useState({ displayName: '', profile: '', avatar: '' });
  const [socketConnected, setSocketConnected] = useState(false);
  const [callState, setCallState] = useState({
    status: 'idle',
    remoteUser: null,
    incomingCall: null,
    type: 'audio',
    callId: null,
    startedAt: null
  });
  const [callDuration, setCallDuration] = useState(0);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const pendingIceCandidatesRef = useRef([]);
  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const callIdRef = useRef(null);
  const fileInputRef = useRef(null);
  const settingsFileInputRef = useRef(null);
  const messagesEndRef = useRef(null);
  const ringtoneContextRef = useRef(null);
  const ringtoneTimerRef = useRef(null);
  const vibrationTimerRef = useRef(null);

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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, typingUsers, selectedUser]);

  useEffect(() => {
    if (callState.status !== 'connected' || !callState.startedAt) {
      return undefined;
    }

    const updateDuration = () => {
      setCallDuration(Math.max(0, Math.floor((Date.now() - callState.startedAt) / 1000)));
    };
    updateDuration();
    const timer = window.setInterval(updateDuration, 1000);
    return () => window.clearInterval(timer);
  }, [callState.status, callState.startedAt]);

  const stopIncomingAlert = () => {
    if (ringtoneTimerRef.current) {
      window.clearInterval(ringtoneTimerRef.current);
      ringtoneTimerRef.current = null;
    }

    if (vibrationTimerRef.current) {
      window.clearInterval(vibrationTimerRef.current);
      vibrationTimerRef.current = null;
    }

    if (navigator.vibrate) navigator.vibrate(0);
    if (ringtoneContextRef.current) {
      ringtoneContextRef.current.close().catch(() => {});
      ringtoneContextRef.current = null;
    }
  };

  const playRingtone = () => {
    stopIncomingAlert();
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      const audioContext = new AudioContext();
      ringtoneContextRef.current = audioContext;
      const ring = () => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
        oscillator.frequency.setValueAtTime(660, audioContext.currentTime + 0.18);
        gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.16, audioContext.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.42);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.45);
      };
      ring();
      ringtoneTimerRef.current = window.setInterval(ring, 1400);
    }

    if (navigator.vibrate) {
      navigator.vibrate([350, 250, 350]);
      vibrationTimerRef.current = window.setInterval(() => {
        navigator.vibrate([350, 250, 350]);
      }, 1400);
    }
  };

  useEffect(() => {
    if (callState.incomingCall) {
      playRingtone();
    } else {
      stopIncomingAlert();
    }

    return stopIncomingAlert;
  }, [callState.incomingCall]);

  const stopStreamTracks = (stream) => {
    stream?.getTracks()?.forEach((track) => track.stop());
  };

  const cleanupCallSession = () => {
    stopIncomingAlert();
    callIdRef.current = null;
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
    setCallDuration(0);
    pendingIceCandidatesRef.current = [];
    setCallState({
      status: 'idle',
      remoteUser: null,
      incomingCall: null,
      type: 'audio',
      callId: null,
      startedAt: null
    });
  };

  const waitForIceGathering = (peerConnection) => {
    if (peerConnection.iceGatheringState === 'complete') {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        peerConnection.removeEventListener('icegatheringstatechange', handleStateChange);
        resolve();
      }, 4000);
      const handleStateChange = () => {
        if (peerConnection.iceGatheringState === 'complete') {
          window.clearTimeout(timeout);
          peerConnection.removeEventListener('icegatheringstatechange', handleStateChange);
          resolve();
        }
      };
      peerConnection.addEventListener('icegatheringstatechange', handleStateChange);
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
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('call:ice-candidate', {
          receiverId: remoteUserId,
          candidate: event.candidate,
          callId: callIdRef.current
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
        setErrors({ api: 'Call connection failed. Check microphone/camera permission and network access.' });
        notifyCallHangup();
        cleanupCallSession();
      }

      if (pc.connectionState === 'connected') {
        setCallState((previous) => ({
          ...previous,
          status: 'connected',
          startedAt: previous.startedAt || Date.now()
        }));
        if (socketRef.current) {
          socketRef.current.emit('call:connected', {
            receiverId: remoteUserId,
            callId: callIdRef.current
          });
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        setErrors({ api: 'Unable to reach the other device. Please retry the call.' });
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
      const callId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      callIdRef.current = callId;
      const stream = await requestLocalStream(callType);
      const pc = await createPeerConnection(user._id);
      setCallState({
        status: 'calling',
        remoteUser: user,
        incomingCall: null,
        type: callType,
        callId,
        startedAt: null
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);

      socketRef.current.emit('call:offer', {
        receiverId: user._id,
        offer,
        callType,
        callId
      });

      setLocalStream(stream);
    } catch (error) {
      setErrors({ api: error.message || 'Unable to start call.' });
    }
  };

  const acceptIncomingCall = async () => {
    if (!callState.incomingCall || !socketRef.current) return;

    try {
      const incomingCall = callState.incomingCall;
      callIdRef.current = incomingCall.callId;
      const stream = await requestLocalStream(incomingCall.callType);
      const pc = await createPeerConnection(incomingCall.fromUserId);
      setCallState({
        status: 'connecting',
        remoteUser: incomingCall.fromUser,
        incomingCall: null,
        type: incomingCall.callType,
        callId: incomingCall.callId,
        startedAt: null
      });

      await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
      for (const candidate of pendingIceCandidatesRef.current) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      pendingIceCandidatesRef.current = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc);

      socketRef.current.emit('call:answer', {
        receiverId: incomingCall.fromUserId,
        answer,
        callId: incomingCall.callId
      });

      setLocalStream(stream);
    } catch (error) {
      setErrors({ api: error.message || 'Unable to accept call.' });
    }
  };

  const notifyCallHangup = () => {
    const remoteUserId = callState.remoteUser?._id || callState.incomingCall?.fromUserId;
    if (socketRef.current && remoteUserId) {
      socketRef.current.emit('call:hangup', {
        receiverId: remoteUserId,
        callId: callState.callId || callState.incomingCall?.callId
      });
    }
  };

  const hangUpCall = () => {
    notifyCallHangup();
    cleanupCallSession();
  };

  const declineIncomingCall = () => {
    notifyCallHangup();
    cleanupCallSession();
  };

  useEffect(() => {
    const handlePageExit = () => {
      notifyCallHangup();
    };

    window.addEventListener('beforeunload', handlePageExit);
    return () => window.removeEventListener('beforeunload', handlePageExit);
  }, [callState.callId, callState.remoteUser, callState.incomingCall]);

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
      const nextUsers = payload.users || [];
      setUsers(nextUsers);
      setSelectedUser((previousUser) => {
        if (!previousUser) return previousUser;
        return nextUsers.find((user) => user._id === previousUser._id) || previousUser;
      });
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

    newSocket.on('friends:update', () => {
      fetchUsers();
      fetchFriends();
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

    newSocket.on('group:open', (payload) => {
      const group = { ...payload.group, isGroup: true };
      const nextMessages = payload.messages || [];
      setConversationMap((prev) => ({ ...prev, [`group:${group._id}`]: nextMessages }));
      setMessages(nextMessages);
      setSelectedUser(group);
      setIsMobileChatOpen(true);
    });

    newSocket.on('group:message:receive', (payload) => {
      const groupKey = `group:${payload.groupId}`;
      setConversationMap((prev) => {
        const existing = prev[groupKey] || [];
        if (existing.some((item) => item.temporaryId === payload.message.temporaryId)) return prev;
        return { ...prev, [groupKey]: [...existing, payload.message] };
      });
      if (selectedUser?.isGroup && String(selectedUser._id) === String(payload.groupId)) {
        setMessages((prev) => prev.some((item) => item.temporaryId === payload.message.temporaryId) ? prev : [...prev, payload.message]);
      }
    });

    newSocket.on('call:incoming', (payload) => {
      if (payload.fromUser) {
        setSelectedUser(payload.fromUser);
        setIsMobileChatOpen(true);
      }
      setCallState({
        status: 'incoming',
        remoteUser: payload.fromUser,
        incomingCall: payload,
        type: payload.callType || 'audio',
        callId: payload.callId || null,
        startedAt: null
      });
    });

    newSocket.on('call:answer', async (payload) => {
      if (!peerConnectionRef.current || !payload.answer || (payload.callId && payload.callId !== callIdRef.current)) return;

      try {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(payload.answer));
        for (const candidate of pendingIceCandidatesRef.current) {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingIceCandidatesRef.current = [];
        setCallState((prev) => ({ ...prev, status: 'connecting' }));
      } catch (error) {
        setErrors({ api: 'Unable to connect the call.' });
      }
    });

    newSocket.on('call:connected', (payload) => {
      if (payload.callId && payload.callId !== callIdRef.current) return;
      setCallState((previous) => ({
        ...previous,
        status: 'connected',
        startedAt: previous.startedAt || Date.now()
      }));
    });

    newSocket.on('call:ice-candidate', async (payload) => {
      if (!payload.candidate || (payload.callId && payload.callId !== callIdRef.current)) return;

      try {
        if (!peerConnectionRef.current?.remoteDescription) {
          pendingIceCandidatesRef.current.push(payload.candidate);
          return;
        }
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch (error) {
        // Ignore candidate errors during negotiation.
      }
    });

    newSocket.on('call:hangup', (payload) => {
      if (payload.callId && payload.callId !== callIdRef.current) return;
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
    if (authUser.role === 'admin') {
      fetchAdminUsers();
    } else {
      fetchFriends();
      fetchGroups();
    }
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

  const fetchGroups = async () => {
    try {
      const response = await fetch(`${API_URL}/api/groups`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Unable to load groups.');
      setGroups(data.groups || []);
    } catch (error) {
      setErrors({ api: error.message || 'Unable to load groups.' });
    }
  };

  const createGroup = async () => {
    const name = window.prompt('Group name');
    if (!name?.trim()) return;
    const selectedIds = friends.acceptedUsers.map((friend) => friend._id);
    if (selectedIds.length === 0) {
      setErrors({ api: 'Accept at least one friend before creating a group.' });
      return;
    }
    try {
      const response = await fetch(`${API_URL}/api/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, memberIds: selectedIds })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Unable to create group.');
      setGroups((prev) => [data.group, ...prev]);
    } catch (error) {
      setErrors({ api: error.message || 'Unable to create group.' });
    }
  };

  const fetchAdminUsers = async () => {
    try {
      const response = await fetch(`${API_URL}/api/admin/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Unable to load admin users.');
      setAdminUsers(data.users || []);
    } catch (error) {
      setErrors({ api: error.message || 'Unable to load admin users.' });
    }
  };

  const handleAdminDeleteUser = async (userId) => {
    if (!window.confirm('Delete this user and all friend requests?')) return;
    try {
      const response = await fetch(`${API_URL}/api/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Unable to delete user.');
      await fetchAdminUsers();
      await fetchUsers();
    } catch (error) {
      setErrors({ api: error.message || 'Unable to delete user.' });
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

  useEffect(() => {
    if (remoteAudioRef.current && remoteStream) {
      remoteAudioRef.current.srcObject = remoteStream;
      remoteAudioRef.current.play().catch(() => {});
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

  const openSettings = () => {
    setSettingsForm({
      displayName: currentUser?.displayName || '',
      profile: currentUser?.profile || '',
      avatar: currentUser?.avatar || ''
    });
    setIsSettingsOpen(true);
  };

  const handleProfileImageSelection = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setErrors({ api: 'Please select an image file.' });
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const size = 320;
        const canvas = document.createElement('canvas');
        const scale = Math.min(size / image.width, size / image.height, 1);
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        setSettingsForm((prev) => ({
          ...prev,
          avatar: canvas.toDataURL('image/jpeg', 0.82)
        }));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  };

  const handleSaveSettings = async (event) => {
    event.preventDefault();
    try {
      const response = await fetch(`${API_URL}/api/auth/me`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(settingsForm)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Unable to update profile.');

      setAuthUser(data.user);
      setUserForSession(data.user);
      setUsers((prev) => prev.map((user) => user._id === data.user._id ? data.user : user));
      setIsSettingsOpen(false);
    } catch (error) {
      setErrors({ api: error.message || 'Unable to update profile.' });
    }
  };

  const openChat = (user) => {
    if (user.isGroup) {
      setSelectedUser(user);
      setIsMobileChatOpen(true);
      setMessages(conversationMap[`group:${user._id}`] || []);
      socketRef.current?.emit('group:open', { groupId: user._id });
      return;
    }
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

  const closeChat = () => {
    if (selectedUser?.isGroup && socketRef.current) {
      socketRef.current.emit('chat:close', { targetUserId: `group:${selectedUser._id}` });
    } else if (selectedUser && socketRef.current) {
      socketRef.current.emit('chat:close', { targetUserId: selectedUser._id });
    }

    setSelectedUser(null);
    setMessages([]);
    setTypingUsers([]);
    setIsMobileChatOpen(false);
    setConversationMap((prev) => {
      if (!selectedUser) return prev;
      const next = { ...prev };
      delete next[selectedUser.isGroup ? `group:${selectedUser._id}` : selectedUser._id];
      return next;
    });
  };

  const sendMessage = (content, type = 'text') => {
    if (!selectedUser || !socketRef.current) return;

    if (!selectedUser.isGroup && !isFriend(selectedUser._id)) {
      setErrors({ api: 'Chat is only available with accepted friends.' });
      return;
    }

    const trimmed = typeof content === 'string' ? content.trim() : '';
    if (!trimmed && type !== 'image') return;

    const clientMessageId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (selectedUser.isGroup) {
      socketRef.current.emit('group:message:send', {
        groupId: selectedUser._id,
        message: type === 'image' ? content : sanitizeText(trimmed).slice(0, 2000),
        type,
        clientMessageId
      });
    } else socketRef.current.emit('message:send', {
      receiverId: selectedUser._id,
      message: type === 'image' ? content : sanitizeText(trimmed).slice(0, 2000),
      type,
      clientMessageId
    });

    setMessageText('');
    socketRef.current.emit('typing:stop', {
      receiverId: selectedUser._id
    });
  };

  const handleSendMessage = () => {
    const trimmed = messageText.trim();
    if (!trimmed) return;
    sendMessage(trimmed, 'text');
  };

  const handleImageSelection = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setErrors({ api: 'Please select an image file.' });
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      sendMessage(String(reader.result), 'image');
      event.target.value = '';
    };
    reader.readAsDataURL(file);
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
          <div className="brand-badge">Σ</div>
          <div>
            <h1>Sigma</h1>
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
            <div className="brand-badge">Σ</div>
            <div>
              <h2>Sigma</h2>
            </div>
          </div>
          <button className="ghost-button" onClick={handleLogout}>Logout</button>
        </div>

        <div className="profile-card">
          {currentUser?.avatar ? <img src={currentUser.avatar} alt="Your profile" className="avatar avatar-image" /> : <div className="avatar">{currentUser?.displayName?.[0]?.toUpperCase() || 'U'}</div>}
          <div>
            <strong>{currentUser?.displayName}</strong>
            <p>@{currentUser?.username}</p>
          </div>
        </div>

        <div className="sidebar-tools">
          <button className="settings-button" onClick={openSettings}>⚙ <span>Settings</span></button>
          <button className="danger-button" onClick={handleDeleteAccount}>Delete account</button>
        </div>

        {currentUser?.role === 'admin' && (
          <section className="admin-panel">
            <div className="admin-panel-heading">
              <h4>Admin users</h4>
              <button className="refresh-button" onClick={fetchAdminUsers} title="Refresh users">↻</button>
            </div>
            {adminUsers.length === 0 ? <p className="muted-text">No registered users</p> : adminUsers.map((user) => (
              <div className="admin-user-row" key={user._id}>
                <div>
                  <strong>{user.displayName}</strong>
                  <span>@{user.username}</span>
                </div>
                <button className="admin-delete-button" onClick={() => handleAdminDeleteUser(user._id)} title={`Delete ${user.username}`}>×</button>
              </div>
            ))}
          </section>
        )}

        <div className="search-box">
          <input
            type="text"
            placeholder="Search users"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="group-section">
          <div className="section-heading">
            <h4>Group chats</h4>
            <button className="create-group-button" onClick={createGroup}>＋</button>
          </div>
          {groups.map((group) => (
            <button key={group._id} className="group-row" onClick={() => openChat({ ...group, isGroup: true })}>
              <span className="group-avatar">{group.name?.[0]?.toUpperCase() || 'G'}</span>
              <span>{group.name}</span>
            </button>
          ))}
        </div>

        <section className="request-panel">
          <div className="section-heading">
            <h4>Friend requests</h4>
            {friends.incomingRequests.length > 0 && <span className="request-count">{friends.incomingRequests.length}</span>}
          </div>
          {friends.incomingRequests.length === 0 ? (
            <p className="muted-text">No incoming requests</p>
          ) : (
            <div className="request-list">
              {friends.incomingRequests.map((request) => (
                <div key={request._id} className="request-card">
                  <div className="request-person">
                    {request.user.avatar ? <img src={request.user.avatar} alt="" className="avatar small avatar-image" /> : <div className="avatar small">{request.user.displayName?.[0]?.toUpperCase() || 'U'}</div>}
                    <div><strong>{request.user.displayName}</strong><span>@{request.user.username}</span></div>
                  </div>
                  <button className="request-accept-button" onClick={() => handleAcceptFriendRequest(request._id)}>Accept</button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="friend-section">
          <div className="section-heading"><h4>Friends</h4><span className="section-count">{friends.acceptedUsers.length}</span></div>
          <div className="user-list">
          {friends.acceptedUsers.map((user) => {
            return (
              <div key={user._id} className={`user-row friend-row ${selectedUser?._id === user._id ? 'active' : ''}`}>
                <button className="user-button" onClick={() => openChat(user)}>
                  {user.avatar ? <img src={user.avatar} alt="" className="avatar small avatar-image" /> : <div className="avatar small">{user.displayName?.[0]?.toUpperCase() || 'U'}</div>}
                  <div className="user-info"><div className="row"><strong>{user.displayName}</strong><span className={user.online ? 'online-dot' : 'offline-dot'} /></div><span>@{user.username}</span></div>
                </button>
              </div>
            );
          })}
          </div>
        </section>

        <section className="people-section">
          <div className="section-heading"><h4>Online people</h4><span className="section-count">{filteredUsers.filter((user) => user._id !== currentUser?._id && user.online && !isFriend(user._id)).length}</span></div>
          <div className="user-list">
          {filteredUsers.filter((user) => user._id !== currentUser?._id && user.online && !isFriend(user._id)).map((user) => {
            const outgoing = hasOutgoingRequest(user._id);
            const incoming = hasIncomingRequest(user._id);

            return (
              <div key={user._id} className={`user-row ${selectedUser?._id === user._id ? 'active' : ''}`}>
                <button className="user-button" onClick={() => openChat(user)}>
                  {user.avatar ? <img src={user.avatar} alt="" className="avatar small avatar-image" /> : <div className="avatar small">{user.displayName?.[0]?.toUpperCase() || 'U'}</div>}
                  <div className="user-info">
                    <div className="row">
                      <strong>{user.displayName}</strong>
                      <span className={user.online ? 'online-dot' : 'offline-dot'} title={user.online ? 'Online' : 'Offline'} />
                    </div>
                    <span>@{user.username}</span>
                  </div>
                </button>

                <button
                    className="friend-button"
                    onClick={() => handleSendFriendRequest(user._id)}
                    disabled={outgoing || incoming}
                  >
                    {outgoing ? 'Requested' : incoming ? 'Request Received' : 'Add Friend'}
                </button>
              </div>
            );
          })}
          </div>
        </section>

        <footer className="app-footer">Developed by <strong>Sigma</strong></footer>
      </aside>

      <main className={`chat-panel ${isMobileChatOpen ? 'chat-open' : ''}`}>
        {selectedUser ? (
          <>
            <header className="chat-header">
              <div className="chat-header-left">
                <button
                  className="back-button"
                  onClick={closeChat}
                >
                  ←
                </button>
                {selectedUser.isGroup ? <div className="avatar small group-avatar">{selectedUser.name?.[0]?.toUpperCase() || 'G'}</div> : selectedUser.avatar ? <img src={selectedUser.avatar} alt="" className="avatar small avatar-image" /> : <div className="avatar small">{selectedUser.displayName?.[0]?.toUpperCase() || 'U'}</div>}
                <div>
                  <h3>{selectedUser.isGroup ? selectedUser.name : selectedUser.displayName}</h3>
                  <p>{selectedUser.isGroup ? `${selectedUser.memberIds?.length || 0} members` : <><span className={selectedUser.online ? 'online-dot' : 'offline-dot'} /> {selectedUser.online ? 'Online' : 'Offline'}</>}</p>
                </div>
              </div>

              {!selectedUser.isGroup && <div className="chat-actions">
                <button className="icon-button" aria-label="Start video call" title="Video call" onClick={() => startCall(selectedUser, 'video')}>📹</button>
                <button className="icon-button" aria-label="Start voice call" title="Voice call" onClick={() => startCall(selectedUser, 'audio')}>📞</button>
              </div>}
            </header>

            {(callState.status !== 'idle' || localStream || remoteStream) && (
              <div className={`call-panel ${callState.type === 'video' ? 'video-call-stage' : 'audio-call-stage'}`}>
                <div className="video-grid">
                  {callState.type === 'video' && (
                    <div className="video-box remote-video-box">
                      {remoteStream ? <video ref={remoteVideoRef} autoPlay playsInline /> : <div className="video-placeholder">{callState.status === 'connected' ? 'Connecting video...' : 'Waiting for answer...'}</div>}
                      <span>{callState.remoteUser?.displayName || 'Remote User'}</span>
                    </div>
                  )}
                  {callState.type === 'video' && localStream && (
                    <div className="video-box local-video-box">
                      <video ref={localVideoRef} autoPlay muted playsInline />
                      <span>You</span>
                    </div>
                  )}
                  <audio ref={remoteAudioRef} autoPlay />
                  {callState.type === 'audio' && (
                    <div className="audio-call-details">
                      <div className="call-avatar">{callState.remoteUser?.displayName?.[0]?.toUpperCase() || 'U'}</div>
                      <strong>{callState.remoteUser?.displayName || 'Contact'}</strong>
                      <span>{callState.status === 'connected' ? formatCallDuration(callDuration) : callState.status === 'calling' ? 'Calling...' : 'Connecting...'}</span>
                    </div>
                  )}
                </div>
                <div className="call-panel-actions">
                  <button className="call-end-button" aria-label="End call" title="End call" onClick={hangUpCall}>☎</button>
                </div>
              </div>
            )}

            <div className="messages">
              {messages.map((msg) => {
                const isMine = msg.senderId === currentUser?._id;
                const isImage = msg.type === 'image' || msg.text?.startsWith('data:image/');
                return (
                  <div key={msg.temporaryId || msg.timestamp} className={`message-row ${isMine ? 'mine' : ''}`}>
                    <div className="message-bubble">
                      {isImage ? (
                        <img src={msg.text} alt="Shared chat media" className="message-image" />
                      ) : (
                        <p>{msg.text}</p>
                      )}
                      <small>{formatTime(msg.timestamp)}</small>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} aria-hidden="true" />
            </div>

            <div className="typing-row">
              {typingUsers.length > 0 && typingUsers.includes(selectedUser._id) ? (
                <span>{selectedUser.displayName} is typing...</span>
              ) : null}
            </div>

            <div className="composer">
              <input
                type="file"
                accept="image/*"
                ref={fileInputRef}
                onChange={handleImageSelection}
                hidden
              />
              <button className="upload-button" aria-label="Share photo" title="Share photo" onClick={() => fileInputRef.current?.click()}>📎</button>
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
              <button className="send-button" aria-label="Send message" title="Send message" onClick={handleSendMessage}>➤</button>
            </div>

          </>
        ) : (
          <div className="empty-chat">
            <h3>Select a user to start chatting</h3>
          </div>
        )}
      </main>

      {callState.incomingCall && (
        <div className="incoming-call-overlay">
          <div className="incoming-call-card">
            <span className="incoming-call-label">Incoming {callState.type === 'video' ? 'video' : 'voice'} call</span>
            <div className="incoming-call-avatar">{callState.remoteUser?.displayName?.[0]?.toUpperCase() || 'U'}</div>
            <h2>{callState.remoteUser?.displayName || 'Unknown caller'}</h2>
            <p>{callState.type === 'video' ? 'Video call' : 'Voice call'} is ringing</p>
            <div className="incoming-call-actions">
              <button className="call-decline-button" onClick={declineIncomingCall}>✕</button>
              <button className="call-accept-button" onClick={acceptIncomingCall}>☎</button>
            </div>
          </div>
        </div>
      )}

      {isSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setIsSettingsOpen(false)}>
          <form className="settings-modal" onSubmit={handleSaveSettings}>
            <div className="settings-heading">
              <div>
                <span className="eyebrow">Account</span>
                <h2>Settings</h2>
              </div>
              <button type="button" className="modal-close" aria-label="Close settings" onClick={() => setIsSettingsOpen(false)}>×</button>
            </div>
            <div className="settings-avatar-wrap">
              {settingsForm.avatar ? <img src={settingsForm.avatar} alt="Profile preview" className="settings-avatar avatar-image" /> : <div className="settings-avatar">{settingsForm.displayName?.[0]?.toUpperCase() || 'U'}</div>}
              <input type="file" accept="image/*" ref={settingsFileInputRef} onChange={handleProfileImageSelection} hidden />
              <button type="button" className="ghost-button" onClick={() => settingsFileInputRef.current?.click()}>Change photo</button>
            </div>
            <label>Display name<input value={settingsForm.displayName} onChange={(event) => setSettingsForm({ ...settingsForm, displayName: event.target.value })} /></label>
            <label>Profile bio<textarea rows="3" value={settingsForm.profile} onChange={(event) => setSettingsForm({ ...settingsForm, profile: event.target.value })} /></label>
            <button className="save-settings-button" type="submit">Save changes</button>
          </form>
        </div>
      )}
    </div>
  );

  return (
    <>
      {authUser && token ? renderChat() : renderAuth()}
    </>
  );
}

export default App;
