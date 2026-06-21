import { HashRouter, Routes, Route } from 'react-router';
import "./App.css";
import Icon from './components/Icon';
import AppLayout from './layouts/AppLayout';
import Dashboard from './pages/Dashboard';
import Session from './pages/Session';
import Settings from './pages/Settings';
import About from './pages/About';
import Search from './pages/Search';
import SetupWizard from './features/setup/SetupWizard';
import { useSetupCheck, clearSetupRerun } from './features/setup/useSetupCheck';

function AppRouter() {
    return (
        <HashRouter>
            <Routes>
                <Route path="/" element={<AppLayout />}>
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

export default function App() {
    const { isComplete, isLoading } = useSetupCheck();

    if (isLoading) {
        return (
            <div className="h-screen bg-surface flex items-center justify-center">
                <Icon name="progress_activity" size={32} className="text-on-surface-variant animate-spin" />
            </div>
        );
    }

    if (!isComplete) {
        return <SetupWizard onComplete={() => { clearSetupRerun(); window.location.reload(); }} />;
    }

    return <AppRouter />;
}