import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs";
import axios from "axios";
import "dotenv/config";
import cors from "cors";  // Import cors package

const app = express();
const PORT = process.env.PORT || 3001;

// Enable CORS for all routes
app.use(cors());  // This will allow all origins by default

// Alternatively, you can configure it to only allow specific origins like this:
// app.use(cors({
//   origin: ['https://your-frontend-url.com'],
// }));

// Ensure FFmpeg is installed
ffmpeg.setFfmpegPath("ffmpeg");

// Configure multer for file uploads
const upload = multer({ dest: "uploads/" });

// Ensure output directory exists
const outputDir = path.resolve("output");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

interface Resolution {
    name: string;
    size: string;
    bitrate: string;
}

// Resolutions for transcoding
const resolutions: Resolution[] = [
    { name: "1080p", size: "1920x1080", bitrate: "5000k" },
    { name: "720p", size: "1280x720", bitrate: "2500k" },
    { name: "480p", size: "854x480", bitrate: "1000k" },
    { name: "360p", size: "640x360", bitrate: "600k" },
];

// Function to get input video resolution
const getVideoResolution = (filePath: string): Promise<number> => {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) reject(err);
            else {
                console.log("Metadata:", metadata); // Log metadata to inspect
                const videoStream = metadata.streams.find((s) => s.codec_type === "video");
                if (videoStream && videoStream.height) resolve(videoStream.height);
                else reject("Could not determine video resolution.");
            }
        });
    });
};

// Function to transcode video
const transcodeVideo = async (
    inputFile: string,
    outputFolder: string,
    inputHeight: number
): Promise<{ name: string; path: string }[]> => {
    if (!fs.existsSync(outputFolder)) fs.mkdirSync(outputFolder);

    const availableResolutions = resolutions.filter(({ size }) => {
        const height = parseInt(size.split("x")[1]);
        return height <= inputHeight || height === inputHeight;
    });

    console.log("Available Resolutions:", availableResolutions); // Debugging step

    const transcodedFiles: { name: string; path: string }[] = [];

    await Promise.all(
        availableResolutions.map(({ name, size, bitrate }) => {
            return new Promise<void>((resolve, reject) => {
                // Create a unique filename using the resolution and current timestamp
                const timestamp = Date.now();
                const outputFileName = `video_${name}_${timestamp}.mp4`;
                const outputFilePath = path.join(outputFolder, outputFileName);

                ffmpeg(inputFile)
                    .outputOptions([ 
                        `-vf scale=${size}`, 
                        `-b:v ${bitrate}`,
                        "-c:v libx264",
                        "-preset veryfast",
                        "-c:a aac",
                        "-b:a 128k",
                    ])
                    .output(outputFilePath)
                    .on("progress", (progress) => {
                        if (progress.percent) {
                            console.log(`🔄 ${name} Progress: ${progress.percent.toFixed(2)}%`);
                        }
                    })
                    .on("end", () => {
                        console.log(`✅ Transcoded: ${name}`);
                        transcodedFiles.push({ name: outputFileName, path: outputFilePath });
                        resolve();
                    })
                    .on("error", (err) => {
                        console.error(`❌ FFmpeg error in ${name}: ${err.message}`);
                        reject(err);
                    })
                    .run();
            });
        })
    );

    return transcodedFiles;
};

// Function to upload a file to Pinata
const uploadToPinata = async (filePath: string): Promise<string> => {
    try {
        const fileStream = fs.createReadStream(filePath);
        const response = await axios.post(
            "https://api.pinata.cloud/pinning/pinFileToIPFS",
            { file: fileStream },
            {
                headers: {
                    "Content-Type": "multipart/form-data",
                    pinata_api_key: process.env.PINATA_API_KEY!,
                    pinata_secret_api_key: process.env.PINATA_SECRET_API_KEY!,
                },
            }
        );
        console.log('Pinata Response:', response.data); // Log Pinata response
        return response.data.IpfsHash;
    } catch (error: any) {
        console.error("❌ Error uploading to Pinata:", error.response?.data || error.message);
        throw error;
    }
};

// API Route: Upload, transcode, and upload to IPFS
app.post("/upload", upload.single("video"), async (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
    }

    const inputFile = req.file.path;
    const outputFolder = path.join(outputDir, `${Date.now()}`);

    try {
        console.log(`📥 Received file: ${inputFile}`);

        // Get input video resolution
        const inputHeight = await getVideoResolution(inputFile);
        console.log(`📏 Detected resolution: ${inputHeight}p`);

        // Transcode the video
        const transcodedFiles = await transcodeVideo(inputFile, outputFolder, inputHeight);

        // Upload transcoded files to Pinata
        const ipfsCIDs: Record<string, { videoCID: string }> = {};
        for (const { name, path } of transcodedFiles) {
            console.log(`🚀 Uploading ${name} to IPFS...`);
            const cid = await uploadToPinata(path);
            ipfsCIDs[name] = { videoCID: cid };
        }

        console.log("✅ All videos uploaded to IPFS:", ipfsCIDs);
        res.json({ message: "Processing complete", files: ipfsCIDs });
    } catch (error: any) {
        console.error("❌ Error:", error.message);
        res.status(500).json({ error: "Processing failed", details: error.message });
    } finally {
        // Cleanup original file
        try {
            if (fs.existsSync(inputFile)) {
                fs.unlinkSync(inputFile);
                console.log(`🗑️ Deleted original file: ${inputFile}`);
            }
        } catch (cleanupError: any) {
            console.error("⚠️ Error deleting file:", cleanupError);
        }
    }
});

// Serve videos
app.use("/videos", express.static(outputDir));

// Start server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
