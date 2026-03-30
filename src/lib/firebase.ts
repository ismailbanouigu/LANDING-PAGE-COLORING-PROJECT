import { initializeApp } from 'firebase/app'
import { getAnalytics, isSupported } from 'firebase/analytics'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyAFefcglfRMXk7QXTdD5R5s3yA8F7qDsKo',
  authDomain: 'landing-page-coloring-pr-78402.firebaseapp.com',
  projectId: 'landing-page-coloring-pr-78402',
  storageBucket: 'landing-page-coloring-pr-78402.firebasestorage.app',
  messagingSenderId: '230788463854',
  appId: '1:230788463854:web:9743d4dac34c805c67c7ff',
  measurementId: 'G-6EF2GT98R6',
}

export const firebaseApp = initializeApp(firebaseConfig)
export const auth = getAuth(firebaseApp)
export const googleProvider = new GoogleAuthProvider()
export const db = getFirestore(firebaseApp)

export async function initAnalytics() {
  if (!import.meta.env.PROD) return null
  try {
    const supported = await isSupported()
    if (!supported) return null
    return getAnalytics(firebaseApp)
  } catch {
    return null
  }
}
