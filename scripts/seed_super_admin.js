import { connectDB } from "../src/config/db.js";
import { SuperAdmin } from "../src/model/superAdmin/superAdmin.model.js";

async function seed() {
    await connectDB();

    const email = (process.env.SUPER_ADMIN_INITIAL_EMAIL || "superadmin@corpilance.com").toLowerCase().trim();
    const password = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "SuperAdmin@2026!SecureKey#";
    const fullName = process.env.SUPER_ADMIN_INITIAL_NAME || "Chief Security Officer (Root)";

    let admin = await SuperAdmin.findOne({ email });

    if (!admin) {
        admin = new SuperAdmin({
            email,
            password, // Mongoose pre-save hook will bcrypt hash this with 12 rounds
            fullName,
            role: "superadmin",
            status: "active",
            twoFactorEnabled: true,
        });
        await admin.save();
        console.log(`\n======================================================`);
        console.log(`🛡️  ROOT SUPER ADMIN CREATED SUCCESSFULLY!`);
        console.log(`Email:    ${email}`);
        console.log(`Password: ${password}`);
        console.log(`Role:     superadmin`);
        console.log(`Status:   active`);
        console.log(`======================================================\n`);
    } else {
        console.log(`\nSuper Admin already exists: ${email}`);
    }

    process.exit(0);
}

seed().catch((err) => {
    console.error("Failed to seed Super Admin:", err);
    process.exit(1);
});
