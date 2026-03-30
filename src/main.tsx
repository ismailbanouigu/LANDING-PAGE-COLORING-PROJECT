import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initializeApp } from 'firebase/app'
import { getAnalytics, isSupported } from 'firebase/analytics'
import './index.css'
import App from './App.tsx'

const firebaseConfig = {
  apiKey: 'AIzaSyAFefcglfRMXk7QXTdD5R5s3yA8F7qDsKo',
  authDomain: 'landing-page-coloring-pr-78402.firebaseapp.com',
  projectId: 'landing-page-coloring-pr-78402',
  storageBucket: 'landing-page-coloring-pr-78402.firebasestorage.app',
  messagingSenderId: '230788463854',
  appId: '1:230788463854:web:9743d4dac34c805c67c7ff',
  measurementId: 'G-6EF2GT98R6',
}

const firebaseApp = initializeApp(firebaseConfig)

if (import.meta.env.PROD) {
  isSupported()
    .then((supported) => {
      if (!supported) return
      getAnalytics(firebaseApp)
    })
    .catch(() => {})
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
