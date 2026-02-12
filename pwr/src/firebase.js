import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, setPersistence, browserLocalPersistence } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
setPersistence(auth, browserLocalPersistence).catch(() => {
  // se falhar, segue com default
});
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(firebaseApp);
export const functions = getFunctions(firebaseApp, "us-central1");

if (import.meta.env.VITE_USE_FUNCTIONS_EMULATOR === "1") {
  connectFunctionsEmulator(functions, "localhost", 5001);
}

export const createAnnualCheckoutLink = httpsCallable(functions, "createAnnualCheckoutLink");
export const getMyAccessStatus = httpsCallable(functions, "getMyAccessStatus");
