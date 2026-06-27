import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './theme.css';

// Honour the visitor's OS colour-scheme preference on first paint so the page
// matches the system the way the app does, while still allowing the in-page toggle.
if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    document.documentElement.classList.add('dark');
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
