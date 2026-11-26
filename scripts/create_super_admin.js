import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
if (!process.env.MONGODB_URI) {
    dotenv.config({ path: path.resolve(__dirname, "../.env") });
}

import { connectDB } from "../src/config/db.js";
import { SuperAdmin } from "../src/model/superAdmin/superAdmin.model.js";

// Helper to parse CLI flags like --email=... or --email ...
function parseArgs() {
    const args = process.argv.slice(2);
    const parsed = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("--")) {
            const key = arg.slice(2);
            if (key.includes("=")) {
                const [k, v] = key.split("=");
                parsed[k] = v;
            } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
                parsed[key] = args[i + 1];
                i++;
            } else {
                parsed[key] = true;
            }
        }
    }
    return parsed;
}

// Interactive prompt helper
function prompt(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function main() {
    console.log(`\n======================================================`);
    console.log(`🛡️  CORPILANCE SUPER ADMIN ACCOUNT CREATOR`);
    console.log(`======================================================\n`);

    const flags = parseArgs();

    let email = flags.email;
    let password = flags.password;
    let fullName = flags.name || flags.fullName;
    let role = flags.role || "superadmin";

    // If not passed via CLI flags, prompt interactively
    if (!email) {
        email = await prompt("Enter Super Admin Email: ");
    }
    if (!email || !email.includes("@")) {
        console.error("❌ Error: A valid email address is required.");
        process.exit(1);
    }
    email = email.toLowerCase().trim();

    if (!fullName) {
        fullName = await prompt("Enter Full Name: ");
    }
    if (!fullName) {
        fullName = "Platform Super Admin";
    }

    if (!password) {
        password = await prompt("Enter Secure Password (min 8 chars): ");
    }
    if (!password || password.length < 8) {
        console.error("❌ Error: Password must be at least 8 characters long.");
        process.exit(1);
    }

    await connectDB();

    let existingAdmin = await SuperAdmin.findOne({ email });

    if (existingAdmin) {
        console.log(`\n⚠️  Super Admin account with email "${email}" already exists.`);
        const overwrite = flags.update || (await prompt("Do you want to update this account's password and details? (y/N): "));
        if (String(overwrite).toLowerCase().startsWith("y")) {
            existingAdmin.password = password; // Will be hashed by pre-save hook
            existingAdmin.fullName = fullName;
            existingAdmin.status = "active";
            existingAdmin.lockUntil = null;
            existingAdmin.failedLoginAttempts = 0;
            existingAdmin.tokenVersion += 1; // Invalidate previous sessions
            await existingAdmin.save();
            console.log(`\n✅ Account "${email}" successfully updated with the new password and active status!`);
        } else {
            console.log("No changes made.");
            process.exit(0);
        }
    } else {
        const newAdmin = new SuperAdmin({
            email,
            password, // Mongoose pre-save hook hashes with bcrypt (12 rounds)
            fullName,
            role,
            status: "active",
            twoFactorEnabled: true,
        });

        await newAdmin.save();

        console.log(`\n✅ NEW SUPER ADMIN CREATED SUCCESSFULLY!`);
        console.log(`------------------------------------------------------`);
        console.log(`Email:     ${email}`);
        console.log(`Full Name: ${fullName}`);
        console.log(`Role:      ${role}`);
        console.log(`Status:    active`);
        console.log(`2FA:       enabled (codes will be sent to ${email} and logged to terminal)`);
        console.log(`------------------------------------------------------`);
        console.log(`\nYou can now log in at http://localhost:3003/login\n`);
    }

    process.exit(0);
}

main().catch((err) => {
    console.error("Fatal error creating super admin:", err);
    process.exit(1);
});
