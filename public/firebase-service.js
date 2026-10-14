// Firebase configuration and service module
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js';
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut, 
  onAuthStateChanged 
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js';
import { 
  getFirestore, 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  collection, 
  query, 
  where, 
  getDocs, 
  getDocFromServer 
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js';

export const firebaseConfig = {
  projectId: "alien-tenure-9v4kj",
  appId: "1:718371241661:web:4d0d4df0b03fcfd89441d4",
  apiKey: "AIzaSyCsccjBabZcCfrDQbbApajPAa1L-TyEt9Q",
  authDomain: "alien-tenure-9v4kj.firebaseapp.com",
  firestoreDatabaseId: "ai-studio-mypoll-e88fba45-eff6-4ae4-aad0-2b7afb046f97",
  storageBucket: "alien-tenure-9v4kj.firebasestorage.app",
  messagingSenderId: "718371241661",
  measurementId: "",
  oAuthClientId: "718371241661-4a7covvj0edkbh5u5rqc0jrj4m3mv61s.apps.googleusercontent.com"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const googleProvider = new GoogleAuthProvider();

export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

export function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Boot connection test
export async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn("Aviso Firebase: verifique a conexão com a nuvem.");
    }
  }
}

// Presenter Authentication Helpers
export function formatAuthError(err) {
  const code = err?.code || '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'E-mail ou senha incorretos. Verifique e tente novamente.';
    case 'auth/email-already-in-use':
      return 'Este e-mail já está cadastrado. Tente entrar com sua senha.';
    case 'auth/invalid-email':
      return 'Endereço de e-mail inválido.';
    case 'auth/weak-password':
      return 'A senha é muito fraca. Digite no mínimo 6 caracteres.';
    case 'auth/popup-closed-by-user':
      return 'Janela de login fechada antes de concluir.';
    case 'auth/user-disabled':
      return 'Esta conta foi desativada.';
    case 'auth/network-request-failed':
      return 'Erro de conexão com a internet. Verifique sua rede.';
    case 'auth/too-many-requests':
      return 'Muitas tentativas sem sucesso. Aguarde um momento e tente novamente.';
    default:
      return err?.message || 'Erro ao realizar autenticação. Tente novamente.';
  }
}

export async function signInWithEmail(email, password) {
  try {
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    if (cred && cred.user) {
      await saveUserProfile(cred.user);
    }
    return cred.user;
  } catch (err) {
    console.error('Erro no login por e-mail:', err);
    throw err;
  }
}

export async function signUpWithEmail(email, password, displayName = '') {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    if (cred && cred.user) {
      const user = cred.user;
      if (displayName) {
        // set display name in user profile
        user.displayName = displayName;
      }
      await saveUserProfile(user);
    }
    return cred.user;
  } catch (err) {
    console.error('Erro no cadastro por e-mail:', err);
    throw err;
  }
}

export async function resetPassword(email) {
  try {
    await sendPasswordResetEmail(auth, email.trim());
  } catch (err) {
    console.error('Erro ao enviar recuperação de senha:', err);
    throw err;
  }
}

export async function signInPresenter() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    if (result && result.user) {
      await saveUserProfile(result.user);
    }
    return result.user;
  } catch (err) {
    console.error('Erro no login Google:', err);
    throw err;
  }
}

export async function signOutPresenter() {
  try {
    await signOut(auth);
  } catch (err) {
    console.error('Erro ao sair:', err);
    throw err;
  }
}

export function onPresenterAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function saveUserProfile(user) {
  if (!user || !user.uid) return;
  const userPath = `users/${user.uid}`;
  try {
    const profile = {
      id: user.uid,
      displayName: user.displayName || 'Apresentador',
      email: user.email || '',
      photoURL: user.photoURL || '',
      createdAt: new Date().toISOString()
    };
    await setDoc(doc(db, 'users', user.uid), profile, { merge: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }
}

// Firestore Polls CRUD
export async function savePollToFirestore(poll) {
  if (!poll || !poll.id) return;
  const path = `polls/${poll.id}`;
  try {
    const now = new Date().toISOString();
    const dataToSave = {
      id: poll.id,
      title: poll.title,
      description: poll.description || '',
      code: poll.code,
      hasProfiles: Boolean(poll.hasProfiles),
      status: poll.status || 'draft',
      currentQuestionId: poll.currentQuestionId || null,
      creatorId: auth.currentUser ? auth.currentUser.uid : (poll.creatorId || 'anonymous'),
      creatorEmail: auth.currentUser ? auth.currentUser.email : (poll.creatorEmail || ''),
      createdAt: poll.createdAt || now,
      updatedAt: now,
      profiles: Array.isArray(poll.profiles) ? poll.profiles : [],
      questions: Array.isArray(poll.questions) ? poll.questions : []
    };
    await setDoc(doc(db, 'polls', poll.id), dataToSave);
    return dataToSave;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function getPollsFromFirestore(userId) {
  const path = 'polls';
  try {
    const q = query(collection(db, 'polls'), where('creatorId', '==', userId));
    const querySnapshot = await getDocs(q);
    const pollsList = [];
    querySnapshot.forEach(docSnap => {
      pollsList.push(docSnap.data());
    });
    // Sort newest first
    pollsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return pollsList;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function getPollFromFirestore(pollId) {
  const path = `polls/${pollId}`;
  try {
    const docSnap = await getDoc(doc(db, 'polls', pollId));
    if (!docSnap.exists()) {
      return null;
    }
    return docSnap.data();
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function deletePollFromFirestore(pollId) {
  const path = `polls/${pollId}`;
  try {
    await deleteDoc(doc(db, 'polls', pollId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}
