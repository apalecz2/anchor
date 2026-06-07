import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface SetupCheckState {
    isComplete: boolean;
    isLoading: boolean;
}

export function useSetupCheck(): SetupCheckState {
    const [state, setState] = useState<SetupCheckState>({ isComplete: false, isLoading: true });

    useEffect(() => {
        invoke<boolean>('check_setup_complete')
            .then(complete => setState({ isComplete: complete, isLoading: false }))
            .catch(() => setState({ isComplete: false, isLoading: false }));
    }, []);

    return state;
}
