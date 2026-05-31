import { HashRouter, Routes, Route } from 'react-router';
import "./App.css";
import AppLayout from './layouts/AppLayout';
import Dashboard from './pages/Dashboard';
import Session from './pages/Session';
import Settings from './pages/Settings';
import About from './pages/About';
import Search from './pages/Search';

//import AppShell from "./app/AppShell";

export default function App() {
    
    /*
    return <AppShell />;
    */

    return (
        <HashRouter>
            <Routes>
                {/* The Layout Route */}
                <Route path="/" element={<AppLayout />}>
                    {/* Child Routes */}
                    <Route index element={<Dashboard />} />
                    <Route path="session/:id" element={<Session />} />
                    <Route path="search" element={<Search />} />
                    <Route path="settings" element={<Settings />} />
                    <Route path="about" element={<About />} />
                </Route>
            </Routes>
        </HashRouter>
    );
}