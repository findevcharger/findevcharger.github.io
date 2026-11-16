// Firebase web configuration. These values are meant to be public;
// access to data is controlled by firestore.rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyA8F3PjRHH5dIMElvK3oZZfnk8TMex9XAw',
  authDomain: 'ev-charging-app-259ca.firebaseapp.com',
  projectId: 'ev-charging-app-259ca',
  storageBucket: 'ev-charging-app-259ca.firebasestorage.app',
  messagingSenderId: '121543080893',
  appId: '1:121543080893:web:30e0a99c68c656c565f0d4',
  measurementId: 'G-101CR2R87N',
};

// Admins see the partner settings form. Keep in sync with isAdmin() in firestore.rules.
export const ADMIN_EMAILS = ['evchargingfinder@gmail.com'];
