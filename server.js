const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const twilio = require("twilio");
const MessagingResponse = require("twilio").twiml.MessagingResponse;
require("dotenv").config(); // loads .env file

const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
);

serviceAccount.private_key =
    serviceAccount.private_key.replace(/\\n/g, "\n");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "clothing-shop-app-15214.firebasestorage.app",
});



const db = admin.firestore();
const bucket = admin.storage().bucket();
const axios = require("axios");
const crypto = require("crypto");
const cloudinary = require('cloudinary').v2;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const userState = {};

// ================= TWILIO CLIENT =================
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ================= CLOUDINARY CONFIG =================
cloudinary.config({
    cloud_name: process.env.CLOUD_NAME || 'dlqgwikp9',
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// ================= DEBUG ENDPOINTS (TEMPORARY) =================

app.get("/check-sa", (req, res) => {
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    res.json({
      project_id: sa.project_id,
      client_email: sa.client_email,
      hasPrivateKey: !!sa.private_key,
      privateKeyStartsWith: sa.private_key.substring(0, 30)
    });
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.get("/test-firestore", async (req, res) => {
  try {
    const snap = await admin.firestore().collection("shops").limit(1).get();

    res.json({
      success: true,
      count: snap.size
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

// ================= KEYWORD MATCHER =================
function matchesKeyword(text, keywords) {
    const t = text.toLowerCase().trim();
    // Use exact match for numbers, and word boundary match for text
    return keywords.some(k => {
        const kw = k.toLowerCase();
        if (/^\d+$/.test(kw)) return t === kw; // Exact match for "1", "2", etc.
        return t === kw || t.startsWith(kw + " ") || t.endsWith(" " + kw) || t.includes(" " + kw + " ");
    });
}

const KEYWORDS = {
    greeting: ["hi", "hello", "menu", "start", "help", "hai", "hey", "hii"],
    register: ["1", "register", "register shop", "add shop", "new shop", "create shop"],
    myshops: ["2", "my shops", "myshops", "my shop", "shops", "switch shop"],
    addproduct: ["3", "add product", "addproduct", "new product", "add item"],
    viewproducts: ["4", "view products", "viewproducts", "list products", "products", "show products"],
    update: ["5", "update", "update product", "edit product", "edit"],
    delete: ["6", "delete", "delete product", "remove product", "remove"],
};

// ================= MESSAGES =================
function getWelcome() {
    return `👋 Welcome to *LocalShop* 🛍️\nYour shop management is just a message away!`;
}

function getMenu() {
    return `📋 *Main Menu*\n\nChoose an option by *number* or *keyword*:\n\n1️⃣  REGISTER SHOP\n2️⃣  MY SHOPS\n3️⃣  ADD PRODUCT\n4️⃣  VIEW PRODUCTS\n5️⃣  UPDATE PRODUCT\n6️⃣  DELETE PRODUCT\n\n💡 _You can type the number or the name, e.g. "register" or "add product"_`;
}

function getSuccess(msg) {
    return `✅ *Success!*\n${msg}`;
}

// ================= SEND TWO MESSAGES =================
async function sendTwoMessages(res, to, contentMsg, menuMsg) {
    try {
        await twilioClient.messages.create({
            from: TWILIO_WHATSAPP_FROM,
            to: to,
            body: menuMsg,
        });
    } catch (err) {
        console.error("⚠️ Failed to send menu message:", err.message);
    }

    const twiml = new MessagingResponse();
    twiml.message(contentMsg);
    res.type("text/xml");
    res.send(twiml.toString());
}

function sendOneMessage(res, msg) {
    const twiml = new MessagingResponse();
    twiml.message(msg);
    res.type("text/xml");
    res.send(twiml.toString());
}

async function uploadToCloudinary(mediaUrl, folder) {
    try {
        const twilioResponse = await axios({
            method: 'get',
            url: mediaUrl,
            auth: {
                username: process.env.TWILIO_ACCOUNT_SID,
                password: process.env.TWILIO_AUTH_TOKEN
            },
            responseType: 'arraybuffer',
            timeout: 30000
        });
        console.log("✅ Downloaded from Twilio");

        const base64 = Buffer.from(twilioResponse.data).toString('base64');

        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', `data:image/jpeg;base64,${base64}`);
        form.append('upload_preset', 'clothing_shop_preset');
        form.append('folder', folder);

        const result = await axios.post(
            'https://api.cloudinary.com/v1_1/dlqgwikp9/image/upload',
            form,
            { headers: form.getHeaders(), timeout: 60000 }
        );

        console.log("✅ Cloudinary URL:", result.data.secure_url);
        return result.data.secure_url;

    } catch (err) {
        console.error("❌ Upload error:", err.message);
        return null;
    }
}

// ================= GEOCODING (OSM Nominatim) =================
async function geocodeAddress(address) {
    try {
        console.log(`🌐 Geocoding address: ${address}`);
        const response = await axios.get("https://nominatim.openstreetmap.org/search", {
            params: {
                q: address,
                format: "json",
                limit: 1
            },
            headers: {
                "User-Agent": "ClothingShopApp/1.0"
            }
        });

        if (response.data && response.data.length > 0) {
            const result = response.data[0];
            return {
                latitude: parseFloat(result.lat),
                longitude: parseFloat(result.lon),
                geocodedAt: new Date()
            };
        }
        return null;
    } catch (err) {
        console.error("❌ Geocoding failed:", err.message);
        return null;
    }
}

// ================= FETCH OWNER SHOPS =================
async function getOwnerShops(from) {
    const snapshot = await db.collection("shops")
        .where("ownerWhatsapp", "==", from)
        .get();

    const shops = [];
    snapshot.forEach(doc => {
        shops.push({ id: doc.id, ...doc.data() });
    });

    shops.sort((a, b) => {
        const aTime = a.createdAt ? a.createdAt.toMillis() : 0;
        const bTime = b.createdAt ? b.createdAt.toMillis() : 0;
        return bTime - aTime;
    });

    return shops;
}

// ================= RESTORE STATE =================
async function restoreState(from) {
    try {
        const shops = await getOwnerShops(from);
        if (shops.length > 0) {
            const latest = shops[0];
            userState[from].shopId = latest.id;
            // Admin panel writes approvalStatus: 'approved' (not the status field).
            // Prefer approvalStatus; fall back to status; default approved for legacy shops.
            const effectiveStatus = latest.approvalStatus || latest.status || "approved";
            userState[from].data = {
                shopName: latest.shopName,
                owner: latest.owner,
                phone: latest.phone,
                location: latest.location,
                category: latest.category,
                image: latest.image || null,
                status: effectiveStatus,
                approvalStatus: effectiveStatus,
            };
            console.log(`🔄 Restored state for ${from} → Shop: ${latest.shopName} (status: ${effectiveStatus})`);
        }
    } catch (err) {
        console.error("⚠️ Could not restore state:", err.message);
    }
}

// ================= WEBHOOK =================
app.post("/whatsapp", async (req, res) => {
    const from = req.body.From;
    const msg = (req.body.Body || "").trim();
    const text = msg.toLowerCase().trim();

    if (!userState[from]) {
        userState[from] = { step: null, data: {}, shopId: null, product: {} };
        await restoreState(from);
    }

    let state = userState[from];

    console.log("📩", msg, "FROM:", from);

    try {
        // 1. Check conversation state FIRST (CRITICAL BUG FIX)
        if (state.step) {
            console.log(`📍 Continuing flow for step: ${state.step}`);

            // --- MY SHOPS SELECT ---
            if (state.step === "MYSHOPS_SELECT") {
                const num = parseInt(msg);
                if (isNaN(num) || num < 1 || num > state.shopsList.length) {
                    return sendOneMessage(res, "⚠️ Invalid number. Please send a valid shop number:");
                }
                const chosen = state.shopsList[num - 1];
                state.shopId = chosen.id;
                state.data = {
                    shopName: chosen.shopName,
                    owner: chosen.owner,
                    phone: chosen.phone,
                    location: chosen.location,
                    category: chosen.category,
                    image: chosen.image || null,
                    status: chosen.status || "approved",
                };
                state.step = null;
                state.shopsList = [];
                return sendTwoMessages(res, from, getSuccess(`Switched to shop *${chosen.shopName}*!`), getMenu());
            }

            // --- REGISTER SHOP STEPS ---
            if (state.step === "NAME") {
                state.data.shopName = msg;
                state.step = "OWNER";
                return sendOneMessage(res, "Enter Owner Name:");
            }
            if (state.step === "OWNER") {
                state.data.owner = msg;
                state.step = "PHONE";
                return sendOneMessage(res, "Enter Phone Number:");
            }
            if (state.step === "PHONE") {
                state.data.phone = msg;
                state.step = "LOCATION";
                return sendOneMessage(res, "Enter Location:");
            }
            if (state.step === "LOCATION") {
                state.data.location = msg;
                const geo = await geocodeAddress(msg);
                if (geo) {
                    state.data.latitude = geo.latitude;
                    state.data.longitude = geo.longitude;
                    state.data.geocodedAt = geo.geocodedAt;
                }
                state.step = "CATEGORY";
                return sendOneMessage(res, "Enter Category:");
            }
            if (state.step === "CATEGORY") {
                state.data.category = msg;
                state.step = "SHOP_IMAGE";
                return sendOneMessage(res, "Send Shop Image or type SKIP:");
            }
            if (state.step === "SHOP_IMAGE") {
                if (text === "skip") {
                    state.data.image = null;
                } else if (req.body.NumMedia && req.body.NumMedia !== "0") {
                    state.data.image = await uploadToCloudinary(req.body.MediaUrl0, "shops");
                } else {
                    return sendOneMessage(res, "⚠️ Send image or type SKIP");
                }

                const shopId = state.data.shopName.replace(/\s+/g, "_") + "_" + Date.now();

                // Save shop with approvalStatus so admin panel can query it
                await db.collection("shops").doc(shopId).set({
                    shopName: state.data.shopName,
                    owner: state.data.owner,
                    ownerName: state.data.owner,   // alias used by admin screen
                    ownerPhone: state.data.phone,  // alias used by admin screen
                    phone: state.data.phone,
                    location: state.data.location,
                    category: state.data.category,
                    image: state.data.image || null,
                    latitude: state.data.latitude || null,
                    longitude: state.data.longitude || null,
                    ownerWhatsapp: from,
                    createdAt: new Date(),
                    status: "pending",
                    approvalStatus: "pending",   // field the admin screen queries (.where 'approvalStatus')
                    submittedAt: new Date(),
                    reviewedAt: null,
                    rejectionReason: null,
                    isVerified: false,
                    verified: false,
                });

                state.shopId = shopId;
                state.step = null;
                return sendOneMessage(res,
                    `⏳ *Registration Received!*\n\n` +
                    `Your shop *${state.data.shopName}* is under review.\n\n` +
                    `Admin will approve within 24 hours.\n` +
                    `You will be notified once approved!`
                );
            }

            // --- ADD PRODUCT STEPS ---
            if (state.step.startsWith("P_")) {
                // Block product addition if shop is not yet approved.
                // Check both approvalStatus (written by admin panel) and status (legacy field).
                const shopPending =
                    state.data &&
                    (state.data.approvalStatus === "pending" || state.data.status === "pending") &&
                    state.data.approvalStatus !== "approved" &&
                    state.data.status !== "approved";
                if (shopPending) {
                    state.step = null;
                    return sendOneMessage(res,
                        `⏳ *Shop Pending Approval*\n\n` +
                        `Your shop is still under review.\n` +
                        `You cannot add products until approved.`
                    );
                }

                if (state.step === "P_NAME") {
                    state.product.name = msg;
                    state.step = "P_PRICE";
                    return sendOneMessage(res, "Enter Price (₹):");
                }
                if (state.step === "P_PRICE") {
                    state.product.price = msg;
                    state.step = "P_STOCK";
                    return sendOneMessage(res, "Enter Stock quantity:");
                }
                if (state.step === "P_STOCK") {
                    state.product.stock = msg;
                    state.step = "P_CATEGORY";
                    return sendOneMessage(res, "Enter Category (e.g. Men's, Women's, Kids):");
                }
                if (state.step === "P_CATEGORY") {
                    state.product.category = msg;
                    state.step = "P_DESC";
                    return sendOneMessage(res, "Enter Description:");
                }
                if (state.step === "P_DESC") {
                    state.product.description = msg;
                    state.step = "P_IMAGE";
                    return sendOneMessage(res, "Send Product Image or type SKIP:");
                }
                if (state.step === "P_IMAGE") {
                    if (text === "skip") {
                        state.product.image = null;
                    } else if (req.body.NumMedia && req.body.NumMedia !== "0") {
                        state.product.image = await uploadToCloudinary(req.body.MediaUrl0, "products");
                    } else {
                        return sendOneMessage(res, "⚠️ Send image or type SKIP");
                    }

                    await db.collection("shops").doc(state.shopId).collection("products").add({
                        ...state.product,
                        price: Number(state.product.price),
                        stock: Number(state.product.stock),
                        shopId: state.shopId,
                        shopName: state.data.shopName,
                        images: state.product.image ? [state.product.image] : [],
                        rating: 0,
                        reviews: 0,
                        createdAt: new Date(),
                    });
                    state.step = null;
                    return sendTwoMessages(res, from, getSuccess(`Product *${state.product.name}* added!`), getMenu());
                }
            }

            // --- UPDATE STEPS ---
            if (state.step === "UPDATE_SELECT") {
                const num = parseInt(msg);
                if (isNaN(num) || num < 1 || num > state.productList.length) {
                    return sendOneMessage(res, "⚠️ Invalid number. Please send a valid product number:");
                }
                state.updateProductId = state.productList[num - 1].id;
                state.updateProductName = state.productList[num - 1].name;
                state.step = "UPDATE_FIELD";
                return sendOneMessage(res, `✏️ *Update "${state.updateProductName}"*\n\nWhat do you want to update?\n\n1. Name\n2. Price\n3. Stock\n4. Category\n5. Description\n6. Image\n\nReply with field number:`);
            }
            if (state.step === "UPDATE_FIELD") {
                const fieldMap = {
                    "1": { key: "name", label: "New Product Name" },
                    "2": { key: "price", label: "New Price" },
                    "3": { key: "stock", label: "New Stock" },
                    "4": { key: "category", label: "New Category" },
                    "5": { key: "description", label: "New Description" },
                    "6": { key: "image", label: "Send New Image or type SKIP" },
                };
                if (!fieldMap[msg]) return sendOneMessage(res, "⚠️ Invalid option. Reply 1-6:");
                state.updateField = fieldMap[msg].key;
                state.step = "UPDATE_VALUE";
                return sendOneMessage(res, `Enter ${fieldMap[msg].label}:`);
            }
            if (state.step === "UPDATE_VALUE") {
                let updateData = {};
                if (state.updateField === "image") {
                    if (text === "skip") updateData.images = [];
                    else if (req.body.NumMedia && req.body.NumMedia !== "0") {
                        const uploadedUrl = await uploadToCloudinary(req.body.MediaUrl0, "products");
                        updateData.images = [uploadedUrl];
                    } else return sendOneMessage(res, "⚠️ Send image or type SKIP");
                } else if (state.updateField === "price" || state.updateField === "stock") {
                    updateData[state.updateField] = Number(msg);
                } else updateData[state.updateField] = msg;

                await db.collection("shops").doc(state.shopId).collection("products").doc(state.updateProductId).update(updateData);
                state.step = null;
                return sendTwoMessages(res, from, getSuccess(`Product *${state.updateProductName}* updated!`), getMenu());
            }

            // --- DELETE STEPS ---
            if (state.step === "DELETE_SELECT") {
                const num = parseInt(msg);
                if (isNaN(num) || num < 1 || num > state.productList.length) {
                    return sendOneMessage(res, "⚠️ Invalid number. Please send a valid product number:");
                }
                state.deleteProductId = state.productList[num - 1].id;
                state.deleteProductName = state.productList[num - 1].name;
                state.step = "DELETE_CONFIRM";
                return sendOneMessage(res, `⚠️ Are you sure you want to delete *${state.deleteProductName}*?\n\nReply *YES* to confirm or *NO* to cancel:`);
            }
            if (state.step === "DELETE_CONFIRM") {
                if (text === "yes") {
                    await db.collection("shops").doc(state.shopId).collection("products").doc(state.deleteProductId).delete();
                    state.step = null;
                    return sendTwoMessages(res, from, getSuccess(`Product *${state.deleteProductName}* deleted!`), getMenu());
                } else if (text === "no") {
                    state.step = null;
                    return sendTwoMessages(res, from, "❌ Delete cancelled.", getMenu());
                } else return sendOneMessage(res, "⚠️ Please reply YES or NO:");
            }
        }

        // 2. Check menu keywords (If no active step)
        if (matchesKeyword(text, KEYWORDS.greeting)) {
            state.step = null;
            state.product = {};
            let welcome = getWelcome();
            if (state.shopId && state.data.shopName) {
                welcome += `\n\n🏪 Active Shop: *${state.data.shopName}*\nStatus: ${state.data.status === 'pending' ? '⏳ Pending' : '✅ Approved'}\n_(Type "my shops" to switch shop)_`;
            }
            return sendTwoMessages(res, from, welcome, getMenu());
        }

        if (matchesKeyword(text, KEYWORDS.register)) {
            state.step = "NAME";
            state.data = {};
            return sendOneMessage(res, "🏪 *Register New Shop*\n\nEnter Shop Name:");
        }

        if (matchesKeyword(text, KEYWORDS.myshops)) {
            const shops = await getOwnerShops(from);
            if (shops.length === 0) return sendTwoMessages(res, from, "⚠️ No shops registered.", getMenu());
            if (shops.length === 1) {
                const s = shops[0];
                state.shopId = s.id;
                state.data = { ...s, status: s.status || "approved" };
                return sendTwoMessages(res, from, getSuccess(`Active shop set to *${s.shopName}*!`), getMenu());
            }
            let msgText = "🏪 *Your Shops*\n\nChoose a shop to work on:\n\n";
            state.shopsList = [];
            shops.forEach((s, idx) => {
                const active = (s.id === state.shopId) ? " ✅ _(active)_" : "";
                msgText += `${idx + 1}. ${s.shopName} — ${s.location}${active}\n`;
                state.shopsList.push(s);
            });
            state.step = "MYSHOPS_SELECT";
            return sendOneMessage(res, msgText + "\nReply with shop number:");
        }

        if (matchesKeyword(text, KEYWORDS.addproduct)) {
            if (!state.shopId) return sendTwoMessages(res, from, "⚠️ Select a shop first.", getMenu());
            if (state.data.status === "pending") return sendOneMessage(res, "⏳ Shop pending approval. Cannot add products.");
            state.step = "P_NAME";
            state.product = {};
            return sendOneMessage(res, `🛍️ *Add Product to ${state.data.shopName}*\n\nEnter Product Name:`);
        }

        if (matchesKeyword(text, KEYWORDS.viewproducts)) {
            if (!state.shopId) return sendTwoMessages(res, from, "⚠️ Select a shop first.", getMenu());
            const snap = await db.collection("shops").doc(state.shopId).collection("products").get();
            if (snap.empty) return sendTwoMessages(res, from, "📦 No products found.", getMenu());
            let msgText = `📦 *Products in ${state.data.shopName}:*\n\n`;
            snap.forEach((doc, idx) => {
                const p = doc.data();
                msgText += `${idx + 1}. ${p.name} — ₹${p.price} | Stock: ${p.stock}\n`;
            });
            return sendTwoMessages(res, from, msgText, getMenu());
        }

        if (matchesKeyword(text, KEYWORDS.update)) {
            if (!state.shopId) return sendTwoMessages(res, from, "⚠️ Select a shop first.", getMenu());
            if (state.data.status === "pending") return sendOneMessage(res, "⏳ Shop pending approval.");
            const snap = await db.collection("shops").doc(state.shopId).collection("products").get();
            if (snap.empty) return sendTwoMessages(res, from, "No products to update.", getMenu());
            let msgText = `✏️ *Update Product*\n\n`;
            state.productList = [];
            snap.forEach((doc, idx) => {
                const p = doc.data();
                msgText += `${idx + 1}. ${p.name} — ₹${p.price}\n`;
                state.productList.push({ id: doc.id, ...p });
            });
            state.step = "UPDATE_SELECT";
            return sendOneMessage(res, msgText + "\nReply with product number:");
        }

        if (matchesKeyword(text, KEYWORDS.delete)) {
            if (!state.shopId) return sendTwoMessages(res, from, "⚠️ Select a shop first.", getMenu());
            if (state.data.status === "pending") return sendOneMessage(res, "⏳ Shop pending approval.");
            const snap = await db.collection("shops").doc(state.shopId).collection("products").get();
            if (snap.empty) return sendTwoMessages(res, from, "No products to delete.", getMenu());
            let msgText = `🗑️ *Delete Product*\n\n`;
            state.productList = [];
            snap.forEach((doc, idx) => {
                const p = doc.data();
                msgText += `${idx + 1}. ${p.name}\n`;
                state.productList.push({ id: doc.id, ...p });
            });
            state.step = "DELETE_SELECT";
            return sendOneMessage(res, msgText + "\nReply with product number:");
        }

        // 3. Default (Unrecognized)
        return sendOneMessage(res, `🤔 Unrecognized input. Type *menu* to see options.`);

    } catch (err) {
        console.error(err);
        return sendOneMessage(res, "❌ An error occurred. Type *menu* to reset.");
    }
});

// ================= SEND FCM NOTIFICATION =================
app.post("/send-fcm", async (req, res) => {
    const { token, title, body, data } = req.body;

    if (!token || !title || !body) {
        return res.status(400).send({ error: "Missing token, title, or body" });
    }

    const payload = {
        token: token,
        notification: { title, body },
        data: data || {},
    };

    try {
        const response = await admin.messaging().send(payload);
        console.log("🚀 FCM Notification sent:", response);
        res.status(200).send({ success: true, response });
    } catch (err) {
        console.error("❌ FCM Notification failed:", err.message);
        res.status(500).send({ error: err.message });
    }
});

// ================= SEND WHATSAPP MESSAGE =================
app.post("/send-whatsapp", async (req, res) => {
    const { to, message } = req.body;

    if (!to || !message) {
        return res.status(400).send({ error: "Missing to or message" });
    }

    // Ignore the legacy approval message sent by the Flutter app.
    // The Firebase Cloud Function 'sendApprovalNotification' now handles this properly.
    if (message.includes("has been approved on StyleHub") && message.includes("Congratulations")) {
        console.log("🛑 Ignoring legacy approval message from Flutter app.");
        return res.status(200).send({ success: true, status: "ignored_legacy_approval" });
    }

    const formattedTo = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
    const formattedFrom = TWILIO_WHATSAPP_FROM.startsWith("whatsapp:") ? TWILIO_WHATSAPP_FROM : `whatsapp:${TWILIO_WHATSAPP_FROM}`;

    try {
        const response = await twilioClient.messages.create({
            from: formattedFrom,
            to: formattedTo,
            body: message,
        });
        console.log("📞 TO:", formattedTo);
        console.log("📡 FROM:", formattedFrom);
        console.log("📲 Status:", response.status);
        res.status(200).send({ success: true, sid: response.sid, status: response.status });
    } catch (err) {
        console.error("❌ WhatsApp Message failed:", err.message);
        res.status(500).send({ error: err.message });
    }
});

const { runAbandonedCartReminders } = require('./notifications/cronJobs');

app.get("/api/notifications/debug-time", (req, res) => {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffset);
    const istHour = istTime.getUTCHours();

    const debugData = {
        serverTime: now.toString(),
        utcHour: now.getUTCHours(),
        istHour: istHour,
        istFullTime: istTime.toUTCString().replace("GMT", "IST"),
        isQuietHours: (istHour >= 22 || istHour < 8)
    };

    console.log("🕒 DEBUG TIME REQUEST:", debugData);
    res.status(200).send(debugData);
});

// ================= TEST ENDPOINT =================
app.get("/api/notifications/test-cart-reminder", async (req, res) => {
    try {
        const bypass = req.query.bypass === 'true';
        const result = await runAbandonedCartReminders(bypass);

        console.log("-----------------------------------------");
        console.log("🧪 TEST ENDPOINT: Cart Reminder Job");
        console.log(`⏰ Current IST Time: ${result.istTime}`);
        console.log(`🤫 Quiet Hours Active: ${result.isQuiet}`);
        console.log(`👥 Users checked: ${result.usersChecked}`);
        console.log(`🛒 Cart items found: ${result.cartItemsFound}`);
        console.log(`🚀 Notifications sent: ${result.sent}`);
        console.log("-----------------------------------------");

        res.status(200).send({ success: true, ...result });
    } catch (err) {
        res.status(500).send({ error: err.message });
    }
});

// ================= ADMIN IMAGE MIGRATION =================
app.get("/api/admin/migrate-images", async (req, res) => {
    try {
        console.log("🚀 Starting Admin Image Migration...");
        let migratedCount = 0;
        let failedCount = 0;
        let skippedCount = 0;

        // 1. Fetch all shops
        const shopsSnap = await db.collection("shops").get();

        for (const shopDoc of shopsSnap.docs) {
            const shopData = shopDoc.data();

            // Check Shop Image
            let shopImage = shopData.image || shopData.imageUrl || shopData.shopImageUrl;
            if (shopImage && (shopImage.includes("twilio.com") || shopImage.includes("fbsbx.com"))) {
                try {
                    const newUrl = await uploadToCloudinary(shopImage, "shops");
                    await shopDoc.ref.update({ image: newUrl, shopImageUrl: newUrl });
                    migratedCount++;
                } catch (e) {
                    failedCount++;
                }
            } else {
                skippedCount++;
            }

            // 2. Fetch all products for this shop
            const productsSnap = await shopDoc.ref.collection("products").get();
            for (const productDoc of productsSnap.docs) {
                const pData = productDoc.data();
                let pUpdated = false;

                // Handle 'images' array
                if (pData.images && Array.isArray(pData.images)) {
                    const newImages = [];
                    for (let img of pData.images) {
                        if (img && (img.includes("twilio.com") || img.includes("fbsbx.com"))) {
                            try {
                                const newUrl = await uploadToCloudinary(img, "products");
                                newImages.push(newUrl);
                                pUpdated = true;
                            } catch (e) {
                                newImages.push(img);
                                failedCount++;
                            }
                        } else {
                            newImages.push(img);
                        }
                    }
                    if (pUpdated) {
                        await productDoc.ref.update({ images: newImages });
                        migratedCount++;
                    } else {
                        skippedCount++;
                    }
                }

                // Handle single 'image' field
                let pImage = pData.image || pData.imageUrl;
                if (pImage && (pImage.includes("twilio.com") || pImage.includes("fbsbx.com"))) {
                    try {
                        const newUrl = await uploadToCloudinary(pImage, "products");
                        await productDoc.ref.update({ image: newUrl, imageUrl: newUrl });
                        if (!pUpdated) migratedCount++; // Don't double count if images array was also updated
                    } catch (e) {
                        failedCount++;
                    }
                }
            }
        }

        res.status(200).send({
            success: true,
            migrated: migratedCount,
            failed: failedCount,
            skipped: skippedCount,
            message: "Migration job completed."
        });
    } catch (err) {
        console.error("❌ Migration failed:", err.message);
        res.status(500).send({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});