import React, { useState } from 'react';
import { useNavigate } from 'react-router';
import { getDb } from '../lib/db';

import { writeFile, mkdir, BaseDirectory } from '@tauri-apps/plugin-fs';
import { join, appDataDir } from '@tauri-apps/api/path';

export default function Dashboard(): React.ReactElement {
    const [isDragging, setIsDragging] = useState(false);
    const navigate = useNavigate();

    // Call after the user selects files to create a session and navigate to the page for it
    const processFilesAndNavigate = async (files: FileList | null) => {
        if (!files || files.length === 0) return;

        let db;
        // Move ID generation up so we can access it in the catch block if we need to clean up
        const newSessionId = crypto.randomUUID();

        try {
            db = await getDb();
            const primaryFile = files[0];

            // 1. Ensure your app's data directory has a 'sessions' folder
            await mkdir('sessions', { baseDir: BaseDirectory.AppData, recursive: true });

            // 2. Create the session record
            await db.execute(
                'INSERT INTO sessions (id, title) VALUES ($1, $2)',
                [newSessionId, primaryFile.name]
            );

            // 3. Process and save the files
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const fileId = crypto.randomUUID();

                const arrayBuffer = await file.arrayBuffer();
                const uint8Array = new Uint8Array(arrayBuffer);

                const extension = file.name.split('.').pop();
                const safeFileName = `${fileId}.${extension}`;

                const relativePath = await join('sessions', safeFileName);
                
                const appData = await appDataDir();
                const absolutePath = await join(appData, relativePath);

                await writeFile(relativePath, uint8Array, { baseDir: BaseDirectory.AppData });

                // Save the ABSOLUTE path to the database so OCR and the Viewer can find it
                await db.execute(
                    'INSERT INTO files (id, session_id, file_name, file_path) VALUES ($1, $2, $3, $4)',
                    [fileId, newSessionId, file.name, absolutePath]
                );
            }

            // Navigate to the new workspace
            navigate(`/session/${newSessionId}`);

        } catch (error) {
            console.error("Failed to process files:", error);

            // 4. Manual "Rollback": If anything fails, delete the session to prevent orphaned data
            if (db) {
                try {
                    await db.execute('DELETE FROM sessions WHERE id = $1', [newSessionId]);
                    console.log("Cleaned up incomplete session data due to an error.");
                } catch (cleanupError) {
                    console.error("Failed to clean up database after error:", cleanupError);
                }
            }
        }
    };

    // Drag and Drop Handlers
    const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isDragging) setIsDragging(true);
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        //const files: FileList = e.dataTransfer.files;
        //console.log('Files dropped:', files);
        processFilesAndNavigate(e.dataTransfer.files);
    };

    const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
        //const files = e.target.files as FileList | null;
        //console.log('Files selected:', files);
        processFilesAndNavigate(e.target.files);
    };

    return (
        <main className="flex-1 p-margin-page flex flex-col items-center justify-center bg-surface relative min-h-screen overflow-hidden">
            {/* Atmospheric background element */}
            <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[radial-gradient(circle_at_center,var(--tw-gradient-stops))] from-primary via-transparent to-transparent"></div>

            <div className="max-w-2xl w-full flex flex-col items-center text-center z-10">
                <h2 className="font-display-lg text-display-lg text-primary mb-4 tracking-tight">Extract Intelligence.</h2>
                <p className="font-body-lg text-body-lg text-on-surface-variant mb-12 max-w-lg">
                    Drop your documents here. Artifact will analyze and extract structured data locally, ensuring complete privacy.
                </p>

                {/* Drag & Drop Zone */}
                <div
                    className={`w-full border border-dashed rounded-xl p-16 flex flex-col items-center justify-center cursor-pointer hover:bg-surface-container-low mb-8 relative group transition-all duration-300 ${isDragging
                            ? 'bg-surface-container-high border-primary'
                            : 'border-outline-variant bg-surface-bright'
                        }`}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                >
                    <input
                        accept=".pdf,.png,.jpg,.jpeg"
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                        multiple
                        type="file"
                        onChange={handleFileInput}
                    />

                    <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                        <span
                            className="material-symbols-outlined text-primary"
                            style={{ fontSize: '32px', fontVariationSettings: "'wght' 300" }}
                        >
                            upload_file
                        </span>
                    </div>

                    <h3 className="font-headline-md text-headline-md text-primary mb-2">Select files to upload</h3>
                    <p className="font-body-md text-body-md text-on-surface-variant">or drag and drop them here</p>
                </div>

                {/* Supported File Types */}
                <div className="flex items-center gap-6 text-on-surface-variant font-label-md text-label-md">
                    <span className="flex items-center gap-2">
                        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>picture_as_pdf</span>
                        PDF
                    </span>
                    <span className="flex items-center gap-2">
                        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>image</span>
                        PNG
                    </span>
                    <span className="flex items-center gap-2">
                        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>image</span>
                        JPEG
                    </span>
                </div>
            </div>
        </main>
    );
}