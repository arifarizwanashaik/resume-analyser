import express from 'express';
import type { Request, Response } from 'express';
import { Pool } from 'pg';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import multer from 'multer';
import path from 'path';

dotenv.config();

// ---------------------------------------------------------
// 1. PDF PARSER V2 SETUP (Class-Based)
// ---------------------------------------------------------
// The debug keys confirmed you have the new version which exports "PDFParse" class
const pdfLib = require('pdf-parse');
const PDFParse = pdfLib.PDFParse || pdfLib.default?.PDFParse;
// ---------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ---------------------------------------------------------
// 2. GEMINI 2.5 FLASH SETUP
// ---------------------------------------------------------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// ---------------------------------------------------------
// 3. AGGRESSIVE RETRY LOGIC (For 503 Overloaded Errors)
// ---------------------------------------------------------
async function generateWithRetry(prompt: string, retries = 5, delay = 3000) {
    for (let i = 0; i < retries; i++) {
        try {
            const result = await model.generateContent(prompt);
            return result;
        } catch (error: any) {
            // 503 = Server is busy (Common for 2.5 Flash)
            const isBusy = error.message.includes('503') || error.message.includes('overloaded');
            
            if (isBusy && i < retries - 1) {
                console.log(`⚠️ Gemini 2.5 is busy. Retrying in ${delay/1000}s... (Attempt ${i + 1}/${retries})`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 1.5; // Wait longer each time
            } else {
                throw error;
            }
        }
    }
    throw new Error("Gemini 2.5 is at max capacity. Please try again in 1 minute.");
}

const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS analyses (
                id SERIAL PRIMARY KEY,
                job_title TEXT,
                match_score INTEGER,
                missing_skills TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("✅ Database connected");
    } catch (err) {
        console.error("❌ DB Error:", err);
    }
};
initDb();

// ---------------------------------------------------------
// 4. THE API ROUTE
// ---------------------------------------------------------
app.post('/api/analyze', upload.single('resume'), async (req: Request, res: Response): Promise<void> => {
    try {
        const file = req.file;
        const { jobDescription, jobTitle } = req.body;

        if (!file || !jobDescription) {
            res.status(400).json({ error: "Resume and JD required" });
            return;
        }

        // A. Extract Text using V2 Class API
        // This fixes the "is not a function" error!
        console.log("📄 Parsing PDF...");
        const parser = new PDFParse({ data: file.buffer });
        const textResult = await parser.getText();
        const resumeText = textResult.text; 

        // B. Send Text to Gemini 2.5
        const prompt = `
            Act as an expert ATS. Compare the RESUME TEXT to the JOB DESCRIPTION.
            
            RESUME:
            ${resumeText.substring(0, 25000)} ... (truncated)
            
            JOB DESCRIPTION:
            ${jobDescription}
            
            OUTPUT JSON ONLY: { "score": 0-100, "missingKeywords": ["skill1"], "advice": "summary" }
            Do not use markdown.
        `;

        console.log("🧠 Sending to Gemini 2.5...");
        const result = await generateWithRetry(prompt);
        const responseText = result.response.text().trim();
        
        const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '');
        const analysis = JSON.parse(cleanJson);

        const saved = await pool.query(
            "INSERT INTO analyses (job_title, match_score, missing_skills) VALUES ($1, $2, $3) RETURNING id",
            [jobTitle || 'Unknown Role', analysis.score, analysis.missingKeywords.join(', ')]
        );

        res.json({ success: true, id: saved.rows[0].id, data: analysis });

    } catch (err: any) {
        console.error("Error:", err.message);
        if (err.message.includes('503')) {
            res.status(503).json({ error: "Gemini 2.5 is overloaded. Please click 'Scan' again." });
        } else {
            res.status(500).json({ error: "Analysis failed. See server logs." });
        }
    }
});

app.get('/', (req: Request, res: Response) => {
    res.sendFile(path.join(process.cwd(), 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`⚡️ Gemini 2.5 Flash Enabled`);
});