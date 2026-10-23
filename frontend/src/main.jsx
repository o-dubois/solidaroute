import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import './i18n'; // must be imported before App
import App from './App';
import './index.css';
import 'react-phone-number-input/style.css';
import 'flag-icons/css/flag-icons.min.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 4000,
          style: { borderRadius: '10px', fontSize: '14px' },
        }}
      />
    </BrowserRouter>
  </React.StrictMode>
);
