const cron = require('node-cron');
const admin = require('firebase-admin');

/**
 * Helper to check if it's quiet hours in IST (10 PM - 8 AM)
 */
function isQuietHours() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000; // IST = UTC+5:30
    const istTime = new Date(now.getTime() + istOffset);
    const hour = istTime.getUTCHours();
    const isQuiet = hour >= 22 || hour < 8;

    console.log("-----------------------------------------");
    console.log("🕒 DEBUG isQuietHours():");
    console.log(`- Raw new Date(): ${now.toISOString()}`);
    console.log(`- After adding IST offset: ${istTime.toISOString()}`);
    console.log(`- Final hour value: ${hour}`);
    console.log(`- Result of (hour >= 22 || hour < 8): ${isQuiet}`);
    console.log("-----------------------------------------");
    
    return isQuiet;
}

/**
 * Check if a user has reached their daily notification limit (max 3)
 * @param {string} userId 
 */
async function hasReachedDailyLimit(userId) {
    const db = admin.firestore();
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Start of day IST (approximate, simpler for logic)
    
    // Better: Start of day in IST
    const istOffset = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(new Date().getTime() + istOffset);
    const startOfDayIST = new Date(nowIST.setHours(0,0,0,0) - istOffset);

    const snapshot = await db.collection('notificationLogs')
        .where('userId', '==', userId)
        .where('sentAt', '>=', startOfDayIST)
        .get();
    
    return snapshot.size >= 3;
}

/**
 * Core logic for abandoned cart reminders
 */
async function runAbandonedCartReminders(bypassQuietHours = false) {
    console.log("🕒 Running Abandoned Cart Reminder Job...");
    
    const istTimeStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const quiet = isQuietHours();

    if (quiet && !bypassQuietHours) {
        console.log("🤫 Quiet hours (IST). Skipping notifications.");
        return { 
            sent: 0, 
            skipped: 0, 
            reason: "Quiet hours",
            usersChecked: 0,
            cartItemsFound: 0,
            istTime: istTimeStr,
            isQuiet: quiet
        };
    }

    if (quiet && bypassQuietHours) {
        console.log("🔓 Quiet hours (IST) detected but BYPASSED for testing.");
    }

    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    let sentCount = 0;
    let skippedCount = 0;
    let usersChecked = 0;
    let cartItemsFound = 0;

    try {
        const usersSnap = await db.collection('users').get();
        
        for (const userDoc of usersSnap.docs) {
            usersChecked++;
            const userId = userDoc.id;
            const userData = userDoc.data();
            const fcmToken = userData.fcmToken;

            if (!fcmToken) continue;

            // Check preference if exists (default true)
            if (userData.cartReminders === false) continue;

            const cartSnap = await db.collection('users').doc(userId).collection('cart').get();
            
            for (const itemDoc of cartSnap.docs) {
                cartItemsFound++;
                const item = itemDoc.data();
                const productId = itemDoc.id;
                const addedAt = item.addedAt?.toDate() || new Date(0);

                let shouldNotify = false;
                let isUrgent = false;

                // 1. Initial 2-hour reminder
                if (addedAt < twoHoursAgo && item.reminderSent === false) {
                    shouldNotify = true;
                } 
                // 2. Second 24-hour reminder
                else if (addedAt < twentyFourHoursAgo && item.reminderSent === true) {
                    // Check if we already sent the 24h reminder
                    // We'll use lastNotifiedAt to ensure we don't spam
                    const lastNotified = item.lastNotifiedAt?.toDate() || new Date(0);
                    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
                    
                    if (lastNotified < twelveHoursAgo) {
                        shouldNotify = true;
                        isUrgent = true;
                    }
                }

                if (shouldNotify) {
                    // Check daily limit
                    if (await hasReachedDailyLimit(userId)) {
                        console.log(`🚫 Daily limit reached for user ${userId}. Skipping.`);
                        skippedCount++;
                        continue;
                    }

                    const title = isUrgent ? "⚠️ Last chance!" : "⏰ Your cart misses you!";
                    const body = isUrgent 
                        ? `${item.name} might sell out soon!` 
                        : `${item.name} is waiting in your cart!`;

                    const payload = {
                        token: fcmToken,
                        notification: {
                            title: title,
                            body: body,
                        },
                        data: {
                            route: "/cart",
                            productId: productId,
                            click_action: "FLUTTER_NOTIFICATION_CLICK"
                        }
                    };

                    try {
                        await admin.messaging().send(payload);
                        
                        // Update cart item
                        await db.collection('users').doc(userId).collection('cart').doc(productId).update({
                            reminderSent: isUrgent ? true : true, // Mark as sent
                            lastNotifiedAt: now,
                        });

                        // Log notification
                        await db.collection('notificationLogs').add({
                            userId,
                            productId,
                            type: "cart",
                            sentAt: now,
                            openedAt: null,
                            purchased: false,
                            isUrgent
                        });

                        console.log(`🚀 Sent cart reminder to ${userId} for ${item.name}`);
                        sentCount++;
                    } catch (err) {
                        console.error(`❌ Failed to send FCM to ${userId}:`, err.message);
                        skippedCount++;
                    }
                }
            }
        }
        
        return { 
            sent: sentCount, 
            skipped: skippedCount, 
            status: "completed",
            usersChecked,
            cartItemsFound,
            istTime: istTimeStr,
            isQuiet: quiet
        };
    } catch (err) {
        console.error("❌ Error in abandoned cart job:", err);
        throw err;
    }
}

// Schedule: Every 1 hour
cron.schedule('0 * * * *', () => {
    runAbandonedCartReminders(false).catch(console.error);
});

// For FAST TESTING (Commented out)
// cron.schedule('*/1 * * * *', () => {
//     console.log("⏱️ Fast cron trigger (1min)");
//     runAbandonedCartReminders().catch(console.error);
// });

module.exports = {
    runAbandonedCartReminders
};
