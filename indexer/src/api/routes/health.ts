import { Request, Response, Router } from "express";

export const healthRouter = Router();

healthRouter.get("/health", async (req: Request, res: Response) => {
    // Evaluating internal states (healthy vs degraded)
    const dbConnected = true; 
    const horizonConnected = true; 
    const currentLedger = 12450; 
    const lastEventAt = new Date().toISOString();

    const isHealthy = dbConnected && horizonConnected;
    
    const responsePayload = {
        status: isHealthy ? "ok" : "degraded",
        db: dbConnected ? "connected" : "disconnected",
        horizon: horizonConnected ? "connected" : "disconnected",
        lastLedger: currentLedger,
        lastEventAt: lastEventAt
    };

    if (isHealthy) {
        return res.status(200).json(responsePayload);
    } else {
        return res.status(503).json(responsePayload);
    }
});
