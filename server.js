// server.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Configuration from environment variables
const CONFIG = {
  UNLOCK_SECRET: process.env.UNLOCK_SECRET || "unlock-is-best",
  LOCK_ADDRESS: process.env.LOCK_ADDRESS, // Your NFT lock address
  NETWORK_ID: process.env.NETWORK_ID || "137", // Polygon
  ETHERMAIL_API_KEY: process.env.ETHERMAIL_API_KEY,
  ETHERMAIL_LIST_ID: process.env.ETHERMAIL_LIST_ID || "68643cb440274653e00b93fa",
  WEBHOOK_URL: process.env.WEBHOOK_URL, // e.g., https://yourdomain.com/unlock-webhook
  
  // Email configuration
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT || 587,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  NOTIFICATION_EMAIL: process.env.NOTIFICATION_EMAIL, // Where to send notifications
};

// Email transporter setup
const transporter = nodemailer.createTransport({
  host: CONFIG.SMTP_HOST,
  port: CONFIG.SMTP_PORT,
  secure: false, // true for 465, false for other ports
  auth: {
    user: CONFIG.SMTP_USER,
    pass: CONFIG.SMTP_PASS,
  },
});

// Utility function to send notification emails
async function sendNotificationEmail(buyerEmail, buyerAddress, transactionHash) {
  const mailOptions = {
    from: CONFIG.SMTP_USER,
    to: CONFIG.NOTIFICATION_EMAIL,
    subject: "🎉 New NFT Purchase!",
    html: `
      <h2>New NFT Purchase Notification</h2>
      <p><strong>Buyer Email:</strong> ${buyerEmail || "Not provided"}</p>
      <p><strong>Buyer Address:</strong> ${buyerAddress}</p>
      <p><strong>Transaction:</strong> <a href="https://polygonscan.com/tx/${transactionHash}" target="_blank">${transactionHash}</a></p>
      <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
      <hr>
      <p>The buyer has been automatically added to your Onboarded Members list in EtherMail.</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("Notification email sent successfully");
  } catch (error) {
    console.error("Error sending notification email:", error);
  }
}

// Utility function to add user to EtherMail list
async function addToEtherMailList(email) {
  if (!email || !CONFIG.ETHERMAIL_API_KEY) {
    console.log("No email or EtherMail API key provided, skipping EtherMail addition");
    return;
  }

  try {
    const response = await fetch(
      `https://hub.ethermail.io/api/lists/${CONFIG.ETHERMAIL_LIST_ID}/contacts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.ETHERMAIL_API_KEY}`,
        },
        body: JSON.stringify({ email }),
      }
    );

    if (response.ok) {
      console.log(`Successfully added ${email} to EtherMail list`);
    } else {
      const error = await response.text();
      console.error("Error adding to EtherMail:", error);
    }
  } catch (error) {
    console.error("Error calling EtherMail API:", error);
  }
}

// Function to subscribe to Unlock Protocol webhooks
async function subscribeToPurchases() {
  if (!CONFIG.LOCK_ADDRESS || !CONFIG.WEBHOOK_URL) {
    console.error("LOCK_ADDRESS and WEBHOOK_URL must be configured");
    return;
  }

  const endpoint = `https://locksmith.unlock-protocol.com/api/hooks/${CONFIG.NETWORK_ID}/keys`;
  const formData = new URLSearchParams();

  formData.set(
    "hub.topic",
    `https://locksmith.unlock-protocol.com/api/hooks/${CONFIG.NETWORK_ID}/keys?locks=${CONFIG.LOCK_ADDRESS}`
  );
  formData.set("hub.callback", CONFIG.WEBHOOK_URL);
  formData.set("hub.mode", "subscribe");
  formData.set("hub.secret", CONFIG.UNLOCK_SECRET);

  try {
    const result = await fetch(endpoint, {
      method: "POST",
      body: formData,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    if (!result.ok) {
      throw new Error(`Failed to subscribe: ${await result.text()}`);
    }
    console.log("Subscribed successfully:", await result.text());
  } catch (error) {
    console.error("Error subscribing to webhooks:", error);
  }
}

// Routes

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "Unlock Protocol Webhook Server",
    timestamp: new Date().toISOString(),
    config: {
      networkId: CONFIG.NETWORK_ID,
      lockAddress: CONFIG.LOCK_ADDRESS,
      webhookUrl: CONFIG.WEBHOOK_URL,
    },
  });
});

// WebSub intent verification (GET request)
app.get("/unlock-webhook", (req, res) => {
  console.log("Intent verification request:", req.query);

  const challenge = req.query["hub.challenge"];
  const secret = req.query["hub.secret"];
  const mode = req.query["hub.mode"];

  // Verify the secret matches
  if (secret !== CONFIG.UNLOCK_SECRET) {
    console.error("Invalid secret in verification request");
    return res.status(400).send("Invalid secret");
  }

  if (mode === "subscribe") {
    console.log("Webhook subscription verified successfully");
    return res.status(200).send(challenge);
  }

  if (mode === "unsubscribe") {
    console.log("Webhook unsubscription verified successfully");
    return res.status(200).send(challenge);
  }

  return res.status(400).send("Invalid mode");
});

// Handle purchase events (POST request)
app.post("/unlock-webhook", async (req, res) => {
  console.log("Purchase event received:", JSON.stringify(req.body, null, 2));

  try {
    const eventData = req.body;
    
    // Extract relevant information from the webhook payload
    const buyerAddress = eventData?.owner || eventData?.keyOwner;
    const buyerEmail = eventData?.email || eventData?.metadata?.email;
    const transactionHash = eventData?.transactionHash;
    const lockAddress = eventData?.lock;

    // Verify this is for our lock
    if (lockAddress && lockAddress.toLowerCase() !== CONFIG.LOCK_ADDRESS?.toLowerCase()) {
      console.log("Event is not for our lock, ignoring");
      return res.status(200).send("OK");
    }

    console.log(`🎉 New NFT purchase detected!`);
    console.log(`Buyer Address: ${buyerAddress}`);
    console.log(`Buyer Email: ${buyerEmail || "Not provided"}`);
    console.log(`Transaction: ${transactionHash}`);

    // 1. Send notification email
    await sendNotificationEmail(buyerEmail, buyerAddress, transactionHash);

    // 2. Add to EtherMail list
    // if (buyerEmail) {
    //   await addToEtherMailList(buyerEmail);
    // }

    res.status(200).send("Event processed successfully");
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal server error");
  }
});

// Manual subscription endpoint (for testing/setup)
app.post("/subscribe", async (req, res) => {
  try {
    await subscribeToPurchases();
    res.json({ success: true, message: "Subscription attempt completed" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual unsubscribe endpoint
app.post("/unsubscribe", async (req, res) => {
  if (!CONFIG.LOCK_ADDRESS || !CONFIG.WEBHOOK_URL) {
    return res.status(400).json({ error: "Missing configuration" });
  }

  const endpoint = `https://locksmith.unlock-protocol.com/api/hooks/${CONFIG.NETWORK_ID}/keys`;
  const formData = new URLSearchParams();

  formData.set(
    "hub.topic",
    `https://locksmith.unlock-protocol.com/api/hooks/${CONFIG.NETWORK_ID}/keys?locks=${CONFIG.LOCK_ADDRESS}`
  );
  formData.set("hub.callback", CONFIG.WEBHOOK_URL);
  formData.set("hub.mode", "unsubscribe");
  formData.set("hub.secret", CONFIG.UNLOCK_SECRET);

  try {
    const result = await fetch(endpoint, {
      method: "POST",
      body: formData,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    if (!result.ok) {
      throw new Error(`Failed to unsubscribe: ${await result.text()}`);
    }
    
    res.json({ success: true, message: "Unsubscribed successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Unlock Protocol webhook server running on port ${PORT}`);
  console.log(`📝 Webhook endpoint: /unlock-webhook`);
  console.log(`🔗 Lock Address: ${CONFIG.LOCK_ADDRESS}`);
  console.log(`🌐 Network: ${CONFIG.NETWORK_ID}`);
  
  // Auto-subscribe on startup if configuration is complete
  if (CONFIG.LOCK_ADDRESS && CONFIG.WEBHOOK_URL) {
    setTimeout(subscribeToPurchases, 2000); // Wait 2 seconds then subscribe
  } else {
    console.log("⚠️  Missing LOCK_ADDRESS or WEBHOOK_URL - manual subscription required");
  }
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  process.exit(0);
});

export default app;