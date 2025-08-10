import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import crypto from "crypto";
import dotenv from "dotenv";
import { ethers } from "ethers";

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
  NETWORK_ID: process.env.NETWORK_ID || "11155111", // Sepolia testnet based on your example
  ETHERMAIL_API_KEY: process.env.ETHERMAIL_API_KEY,
  ETHERMAIL_API_SECRET: process.env.ETHERMAIL_API_SECRET,
  ETHERMAIL_LIST_ID: process.env.ETHERMAIL_LIST_ID || "68643cb440274653e00b93fa",
  WEBHOOK_URL: process.env.WEBHOOK_URL, // e.g., https://yourdomain.com/unlock-webhook
  PRIVATE_KEY: process.env.PRIVATE_KEY, // Add your private key for signing
  
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

// Global variable to store auth token and expiry
let authToken = null;
let tokenExpiry = null;

// Function to authenticate with Unlock Protocol
async function authenticateWithUnlock() {
  if (!CONFIG.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY environment variable is required");
  }

  try {
    // Create wallet from private key
    const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY);
    
    // Create SIWE message
    const nonce = crypto.randomBytes(8).toString("hex");
    const issuedAt = new Date().toISOString();
    
    const siweMessage = [
      `${CONFIG.WEBHOOK_URL?.replace(/\/.*$/, '') || 'localhost'} wants you to sign in with your Ethereum account:`,
      wallet.address,
      ``,
      `Sign in to Unlock Protocol`,
      ``,
      `URI: ${CONFIG.WEBHOOK_URL?.replace(/\/.*$/, '') || 'http://localhost:3000'}`,
      `Version: 1`,
      `Chain ID: ${CONFIG.NETWORK_ID}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt}`,
    ].join("\n");

    // Sign the message
    const signature = await wallet.signMessage(siweMessage);

    // Authenticate with Locksmith
    const response = await fetch(
      `https://locksmith.unlock-protocol.com/v2/auth/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: siweMessage,
          signature,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Authentication failed: ${await response.text()}`);
    }

    const data = await response.json();
    
    // Store token and set expiry (tokens typically last 24 hours, set to 23 hours to be safe)
    authToken = data.accessToken;
    tokenExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000); // 23 hours from now
    
    console.log("✅ Successfully authenticated with Unlock Protocol");
    return data.accessToken;
    
  } catch (error) {
    console.error("❌ Error authenticating with Unlock:", error);
    throw error;
  }
}

// Function to get valid auth token (refresh if needed)
async function getValidAuthToken() {
  if (!authToken || !tokenExpiry || new Date() >= tokenExpiry) {
    console.log("🔄 Auth token expired or missing, refreshing...");
    return await authenticateWithUnlock();
  }
  return authToken;
}

// Function to get buyer metadata from Unlock Protocol
async function getBuyerMetadata(tokenId) {
  try {
    const token = await getValidAuthToken();
    
    const response = await fetch(
      `https://locksmith.unlock-protocol.com/v2/api/metadata/${CONFIG.NETWORK_ID}/locks/${CONFIG.LOCK_ADDRESS}/keys/${tokenId}`,
      {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "Authorization": `Bearer ${token}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to fetch metadata: ${response.status} ${errorText}`);
      throw new Error(`Failed to fetch metadata: ${response.status} ${errorText}`);
    }

    const metadata = await response.json();
    console.log("📊 Retrieved buyer metadata:", JSON.stringify(metadata, null, 2));
    
    // Extract email and fullname from the correct path based on your example
    const email = metadata?.userMetadata?.protected?.email || metadata?.userMetadata?.public?.email;
    const fullname = metadata?.userMetadata?.protected?.fullname || metadata?.userMetadata?.public?.fullname;
    const newsletterOptin = metadata?.userMetadata?.protected?.['newsletter-optin'];
    
    // Extract event details if available
    const eventDetails = metadata?.ticket ? {
      eventName: metadata.name || "Event",
      eventStartDate: metadata.ticket.event_start_date,
      eventStartTime: metadata.ticket.event_start_time,
      eventEndDate: metadata.ticket.event_end_date,
      eventEndTime: metadata.ticket.event_end_time,
      eventTimezone: metadata.ticket.event_timezone,
      eventAddress: metadata.ticket.event_address,
      isInPerson: metadata.ticket.event_is_in_person
    } : null;
    
    return {
      email,
      fullname,
      newsletterOptin,
      eventDetails,
      tokenId: metadata.tokenId,
      owner: metadata.owner,
      lockAddress: metadata.lockAddress,
      network: metadata.network,
      metadata
    };
    
  } catch (error) {
    console.error("❌ Error fetching buyer metadata:", error);
    return { 
      email: null, 
      fullname: null, 
      newsletterOptin: null, 
      eventDetails: null, 
      metadata: null 
    };
  }
}

// Utility function to send notification emails
async function sendNotificationEmail(buyerData, transactionHash) {
  const { email, fullname, eventDetails, owner } = buyerData;
  
  // Create event details HTML if available
  let eventDetailsHtml = '';
  if (eventDetails) {
    const eventStart = `${eventDetails.eventStartDate} at ${eventDetails.eventStartTime} (${eventDetails.eventTimezone})`;
    const eventEnd = `${eventDetails.eventEndDate} at ${eventDetails.eventEndTime} (${eventDetails.eventTimezone})`;
    const location = eventDetails.isInPerson ? 
      (eventDetails.eventAddress || 'Location TBD') : 
      `<a href="${eventDetails.eventAddress}" target="_blank">Join Virtual Event</a>`;
    
    eventDetailsHtml = `
      <h3>Event Details</h3>
      <p><strong>Event:</strong> ${eventDetails.eventName}</p>
      <p><strong>Start:</strong> ${eventStart}</p>
      <p><strong>End:</strong> ${eventEnd}</p>
      <p><strong>Location:</strong> ${location}</p>
      <p><strong>Type:</strong> ${eventDetails.isInPerson ? 'In-Person' : 'Virtual'}</p>
    `;
  }

  const mailOptions = {
    from: CONFIG.SMTP_USER,
    to: CONFIG.NOTIFICATION_EMAIL,
    subject: "🎉 New NFT Ticket Purchase!",
    html: `
      <h2>🎫 New Ticket Purchase Notification</h2>
      <h3>Buyer Information</h3>
      <p><strong>Name:</strong> ${fullname || "Not provided"}</p>
      <p><strong>Email:</strong> ${email || "Not provided"}</p>
      <p><strong>Wallet Address:</strong> ${owner}</p>
      <p><strong>Newsletter Opt-in:</strong> ${buyerData.newsletterOptin === 'true' ? 'Yes' : 'No'}</p>
      
      ${eventDetailsHtml}
      
      <h3>Transaction Details</h3>
      <p><strong>Transaction Hash:</strong> <a href="https://${CONFIG.NETWORK_ID === '1' ? '' : CONFIG.NETWORK_ID === '137' ? 'polygonscan' : 'sepolia.etherscan'}.com/tx/${transactionHash}" target="_blank">${transactionHash}</a></p>
      <p><strong>Token ID:</strong> ${buyerData.tokenId}</p>
      <p><strong>Network:</strong> ${CONFIG.NETWORK_ID}</p>
      <p><strong>Lock Address:</strong> ${buyerData.lockAddress}</p>
      <p><strong>Purchase Time:</strong> ${new Date().toLocaleString()}</p>
      
      <hr>
      <p style="color: #666; font-size: 0.9em;">
        ${email ? 'The buyer has been automatically added to your EtherMail list.' : 'No email provided - buyer not added to EtherMail list.'}
      </p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("✅ Notification email sent successfully");
  } catch (error) {
    console.error("❌ Error sending notification email:", error);
  }
}

// Utility function to add user to EtherMail list
async function addToEtherMailList(email, fullname = null) {
  if (!email || !CONFIG.ETHERMAIL_API_KEY) {
    console.log("⚠️ No email or EtherMail API key provided, skipping EtherMail addition");
    return false;
  }

  try {
    const contactData = { email, lists: [CONFIG.ETHERMAIL_LIST_ID] };
    if (fullname) {
      contactData.first_name = fullname;
    }

    const response = await fetch(
      `https://hub-gateway.ethermail.io/v1/contacts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CONFIG.ETHERMAIL_API_KEY,
          "x-api-secret": CONFIG.ETHERMAIL_API_SECRET,
        },
        body: JSON.stringify(contactData),
      }
    );

    if (response.ok) {
      console.log(`✅ Successfully added ${email} (${fullname || 'No name'}) to EtherMail list`);
      return true;
    } else {
      const error = await response.text();
      console.error("❌ Error adding to EtherMail:", error);
      return false;
    }
  } catch (error) {
    console.error("❌ Error calling EtherMail API:", error);
    return false;
  }
}

// Function to subscribe to Unlock Protocol webhooks
async function subscribeToPurchases() {
  if (!CONFIG.LOCK_ADDRESS || !CONFIG.WEBHOOK_URL) {
    console.error("❌ LOCK_ADDRESS and WEBHOOK_URL must be configured");
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
    console.log("✅ Subscribed successfully:", await result.text());
  } catch (error) {
    console.error("❌ Error subscribing to webhooks:", error);
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
      hasAuthToken: !!authToken,
      tokenExpiry: tokenExpiry?.toISOString()
    },
  });
});

// WebSub intent verification (GET request)
app.get("/unlock-webhook", (req, res) => {
  console.log("🔍 Intent verification request:", req.query);

  const challenge = req.query["hub.challenge"];
  const secret = req.query["hub.secret"];
  const mode = req.query["hub.mode"];

  // Verify the secret matches
  if (secret !== CONFIG.UNLOCK_SECRET) {
    console.error("❌ Invalid secret in verification request");
    return res.status(400).send("Invalid secret");
  }

  if (mode === "subscribe") {
    console.log("✅ Webhook subscription verified successfully");
    return res.status(200).send(challenge);
  }

  if (mode === "unsubscribe") {
    console.log("✅ Webhook unsubscription verified successfully");
    return res.status(200).send(challenge);
  }

  return res.status(400).send("Invalid mode");
});

// Handle purchase events (POST request)
app.post("/unlock-webhook", async (req, res) => {
  console.log("🎫 Purchase event received:", JSON.stringify(req.body, null, 2));

  try {
    const eventData = req.body;
    
    // Extract basic information from the webhook payload
    const buyerAddress = eventData?.owner || eventData?.keyOwner;
    const transactionHash = eventData?.transactionHash;
    const lockAddress = eventData?.lock;

    // Verify this is for our lock
    if (lockAddress && lockAddress.toLowerCase() !== CONFIG.LOCK_ADDRESS?.toLowerCase()) {
      console.log("⚠️ Event is not for our lock, ignoring");
      return res.status(200).send("OK");
    }

    let processedBuyers = [];

    // Process each key in the event data
    if (eventData.data && eventData.data.length > 0) {
      for (const key of eventData.data) {
        const tokenId = key.tokenId;
        const transactionHash = key.transactionHash[0];
        
        if (tokenId) {
          console.log(`📊 Fetching metadata for token ID: ${tokenId}`);
          
          // Get buyer metadata using authenticated API call
          const buyerData = await getBuyerMetadata(tokenId);
          
          if (buyerData.email || buyerData.fullname) {
            processedBuyers.push(buyerData);
            
            console.log(`👤 Buyer Name: ${buyerData.fullname || "Not provided"}`);
            console.log(`📧 Buyer Email: ${buyerData.email || "Not provided"}`);
            console.log(`📰 Newsletter Opt-in: ${buyerData.newsletterOptin || "Not specified"}`);
            
            // Send notification email for each buyer
            await sendNotificationEmail(buyerData, transactionHash);

            // Add to EtherMail list if email exists
            if (buyerData.email) {
              await addToEtherMailList(buyerData.email, buyerData.fullname);
            }
          } else {
            console.log(`⚠️ No buyer data found for token ID: ${tokenId}`);
          }
        }
      }
    }

    if (processedBuyers.length === 0) {
      console.log("⚠️ No buyer data could be retrieved from the webhook");
    }

    console.log(`🎉 Successfully processed ${processedBuyers.length} buyer(s)`);
    res.status(200).send("Event processed successfully");
    
  } catch (error) {
    console.error("❌ Error processing webhook:", error);
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

// Test endpoint to check authentication and fetch sample metadata
app.get("/test-auth/:tokenId", async (req, res) => {
  try {
    const token = await getValidAuthToken();
    const result = { success: true, message: "Authentication successful", hasToken: !!token };
    
    // If token ID provided, test fetching metadata
    if (req.params.tokenId) {
      const buyerData = await getBuyerMetadata(req.params.tokenId);
      result.testMetadata = buyerData;
    }
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/test-ethermail", async (req, res) => {
  try {
    const { email, fullname } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        error: "Email is required in request body" 
      });
    }

    console.log(`🧪 Testing EtherMail integration for: ${email} (${fullname || 'No name'})`);
    
    const result = await addToEtherMailList(email, fullname);
    
    res.json({ 
      success: result, 
      message: result 
        ? `Successfully added ${email} to EtherMail list`
        : `Failed to add ${email} to EtherMail list`,
      email,
      fullname: fullname || null,
      etherMailConfig: {
        hasApiKey: !!CONFIG.ETHERMAIL_API_KEY,
        listId: CONFIG.ETHERMAIL_LIST_ID
      }
    });
    
  } catch (error) {
    console.error("❌ Error testing EtherMail:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      etherMailConfig: {
        hasApiKey: !!CONFIG.ETHERMAIL_API_KEY,
        listId: CONFIG.ETHERMAIL_LIST_ID
      }
    });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Unlock Protocol webhook server running on port ${PORT}`);
  console.log(`📝 Webhook endpoint: /unlock-webhook`);
  console.log(`🔗 Lock Address: ${CONFIG.LOCK_ADDRESS}`);
  console.log(`🌐 Network: ${CONFIG.NETWORK_ID}`);
  
  // Initialize authentication
  if (CONFIG.PRIVATE_KEY) {
    try {
      await authenticateWithUnlock();
    } catch (error) {
      console.error("❌ Initial authentication failed:", error.message);
    }
  } else {
    console.log("⚠️  Missing PRIVATE_KEY - authentication disabled");
  }
  
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