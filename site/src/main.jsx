import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
/* Fonts ship with the bundle — no CDN, so the CSP can stay shut and the
   page renders the same offline. */
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter-tight/500.css'
import '@fontsource/inter-tight/700.css'
import '@fontsource/inter-tight/800.css'
import '@fontsource/inter-tight/900.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './styles.css'
import App from './App'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
