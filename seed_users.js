// api/seed_users.js
/**
 * User Seeding & Initialization Script
 * -------------------------------------------------------------
 * This script initializes:
 *   1. CEO / Founder User
 *   2. HR User
 *   3. Manager User
 *   4. Employee 1 User
 *   5. Employee 2 User
 *
 * You can edit the passwords in the USERS_TO_CREATE list below
 * before running the script.
 * -------------------------------------------------------------
 */

import mongoose from "mongoose";
import { connectDB } from "./src/config/db.js";
import { User } from "./src/model/auth/auth.model.js";
import { Employee } from "./src/model/employee/employee.model.js";
import { Workspace } from "./src/model/workspace/workspace.model.js";
import { hashPassword } from "./src/utils/password.js";

// =============================================================
// CONFIGURE YOUR USERS & PASSWORDS HERE
// =============================================================
const USERS_TO_CREATE = [
    {
        // 1. CEO User (Workspace Owner)
        _id: "6ad11c54b38ca5f8967b7d47", // Preserves existing CEO ID & workspace ownership
        fullName: "Ahmed Hassan",
        email: "ahassan00789@gmail.com",
        password: "ahmed@hassan!123", // <-- Set your desired password
        role: "Founder / CEO",
        systemRole: "Admin",
        linkedEmployeeId: "EXEC-001",
    },
    {
        // 2. HR User
        _id: "6ae171600306087374c289ee", // Preserves existing HR ID
        fullName: "Hassan Iqbal",
        email: "ahmvdhas@gmail.com",
        password: "ahmed@hassan!123", // <-- Set your desired password
        role: "HR",
        systemRole: "HR",
        linkedEmployeeId: "EMP-00002",
    },
    {
        // 3. Manager User
        _id: "6ae72463ed37074ce1d0f98b", // Preserves existing Manager ID
        fullName: "Muhammad Maaz",
        email: "offtry.pk@gmail.com",
        password: "Ahmed@hassan!123", // <-- Set your desired password
        role: "Manager",
        systemRole: "Manager",
        linkedEmployeeId: "EMP-00004",
    },
];

async function seed() {
    console.log("==================================================");
    console.log(" Starting User Collection Seeding");
    console.log("==================================================");

    await connectDB();

    // 1. Resolve workspace (Esajees primary workspace)
    let workspace = await Workspace.findById("6ad11cb1c88952f01eebaca0");
    if (!workspace) {
        workspace = await Workspace.findOne().sort({ createdAt: 1 });
    }
    if (!workspace) {
        console.error("❌ No workspace found in database. Please create a workspace first.");
        process.exit(1);
    }
    console.log(`Target Workspace: "${workspace.companyName || workspace.name}" (ID: ${workspace._id})`);

    const createdUsers = [];

    for (const conf of USERS_TO_CREATE) {
        const hashedPassword = await hashPassword(conf.password);
        const userId = new mongoose.Types.ObjectId(conf._id);

        const userData = {
            _id: userId,
            fullName: conf.fullName,
            email: conf.email.toLowerCase().trim(),
            password: hashedPassword,
            company: workspace.companyName || "Esajees",
            companySize: "1-10",
            role: conf.role,
            systemRole: conf.systemRole,
            status: "active",
            emailVerified: true,
            workspaceId: workspace._id,
            setupCompletedAt: new Date(),
        };

        // Upsert user into database
        const user = await User.findByIdAndUpdate(
            userId,
            { $set: userData },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // Link with employee record if employeeId exists
        if (conf.linkedEmployeeId) {
            await Employee.findOneAndUpdate(
                {
                    workspace: workspace._id,
                    employeeId: conf.linkedEmployeeId,
                },
                {
                    $set: {
                        linkedUser: user._id,
                        user: user._id,
                        loginEmail: conf.email.toLowerCase().trim(),
                        systemRole: conf.systemRole,
                    },
                }
            );
        }

        createdUsers.push({
            Role: conf.role,
            Name: conf.fullName,
            Email: conf.email,
            Password: conf.password,
            EmployeeId: conf.linkedEmployeeId || "—",
        });
    }

    // Ensure workspace owner is pointing to CEO user
    const ceoConfig = USERS_TO_CREATE.find((u) => u.role === "Founder / CEO" || u.systemRole === "Admin");
    if (ceoConfig) {
        await Workspace.findByIdAndUpdate(workspace._id, {
            $set: { owner: new mongoose.Types.ObjectId(ceoConfig._id) },
        });
    }

    console.log("\n Successfully initialized users in database:\n");
    console.table(createdUsers);

    console.log("\nAll users are active, email-verified, and linked to their employee profiles.");
    console.log("You can now log in with these credentials.");

    await mongoose.disconnect();
    console.log("\nDisconnected from MongoDB. Done!");
}

seed().catch((err) => {
    console.error("❌ Seeding failed:", err);
    process.exit(1);
});
