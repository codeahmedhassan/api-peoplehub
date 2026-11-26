import mongoose from "mongoose";

const AiDatasetRecordSchema = new mongoose.Schema(
    {
        dataset_name: {
            type: String,
            required: true,
            index: true,
            trim: true,
        },
        version: {
            type: String,
            required: true,
            default: "v1.0",
        },
        records_count: {
            type: Number,
            default: 0,
        },
        feature_schema: {
            type: [String],
            default: [],
        },
        sample_data: {
            type: [mongoose.Schema.Types.Mixed],
            default: [],
        },
        quality_score: {
            type: Number,
            default: 100,
            min: 0,
            max: 100,
        },
        provenance: {
            source_modules: { type: [String], default: [] },
            generated_by: { type: String, default: "system" },
            extraction_duration_ms: { type: Number, default: 0 },
            anonymization_method: { type: String, default: "sha256_salted_hash_and_scaling" },
        },
        data_hash: {
            type: String,
            default: "",
        },
        created_at: {
            type: Date,
            default: Date.now,
            index: true,
        },
    },
    {
        timestamps: false,
        collection: "ai_dataset_records",
    }
);

AiDatasetRecordSchema.index({ dataset_name: 1, version: 1 }, { unique: true });
AiDatasetRecordSchema.index({ created_at: -1 });

export const AiDatasetRecord =
    mongoose.models.AiDatasetRecord || mongoose.model("AiDatasetRecord", AiDatasetRecordSchema);
