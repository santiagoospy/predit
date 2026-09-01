import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Solo el subconjunto latino: los .css genericos arrastran cirilico, griego y
// vietnamita, y todo esto se precachea para que la app ande en modo avion.
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Falta el div #root en index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
