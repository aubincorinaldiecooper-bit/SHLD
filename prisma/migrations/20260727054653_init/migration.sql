-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('mcp', 'api', 'github', 'internal');

-- CreateEnum
CREATE TYPE "RepositoryProvider" AS ENUM ('github');

-- CreateEnum
CREATE TYPE "RepositoryStatus" AS ENUM ('pending', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "TargetEnvironmentType" AS ENUM ('preview', 'staging', 'test');

-- CreateEnum
CREATE TYPE "TargetAuthorizationStatus" AS ENUM ('pending', 'authorized', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "SecurityRunType" AS ENUM ('change_review', 'repository_scan', 'finding_validation', 'fix_verification');

-- CreateEnum
CREATE TYPE "SecurityRunStatus" AS ENUM ('queued', 'classifying', 'source_review_running', 'source_review_completed', 'validation_waiting_for_target', 'validation_running', 'awaiting_fix', 'fix_verification_running', 'completed', 'blocked', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "Engine" AS ENUM ('deepsec', 'strix');

-- CreateEnum
CREATE TYPE "EngineExecutionStatus" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('critical', 'high', 'medium', 'low', 'info');

-- CreateEnum
CREATE TYPE "FindingConfidence" AS ENUM ('high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('suspected', 'source_confirmed', 'validation_queued', 'confirmed', 'not_reproduced', 'inconclusive', 'fix_pending', 'fix_submitted', 'retesting', 'verified_fixed', 'still_exploitable', 'accepted_risk', 'dismissed');

-- CreateEnum
CREATE TYPE "DiscoveryEngine" AS ENUM ('deepsec', 'strix');

-- CreateEnum
CREATE TYPE "FindingClass" AS ENUM ('source', 'dynamic');

-- CreateEnum
CREATE TYPE "ValidationStatus" AS ENUM ('pending', 'confirmed', 'not_reproduced', 'inconclusive', 'not_applicable', 'failed');

-- CreateEnum
CREATE TYPE "RemediationOutcome" AS ENUM ('pending', 'passed', 'failed', 'not_applicable', 'inconclusive');

-- CreateEnum
CREATE TYPE "RemediationFinalStatus" AS ENUM ('pending', 'verified_fixed', 'still_exploitable', 'partially_fixed', 'inconclusive', 'verification_failed');

-- CreateEnum
CREATE TYPE "ArtifactType" AS ENUM ('source_snapshot', 'deepsec_raw_output', 'deepsec_config', 'strix_raw_output', 'strix_instruction', 'proof_of_concept', 'receipt_json', 'receipt_markdown', 'other');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('passed', 'passed_with_findings', 'blocked', 'awaiting_fix', 'inconclusive', 'failed');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('agent', 'user', 'system', 'github');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'delivered', 'failed', 'exhausted');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_identities" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AgentType" NOT NULL,
    "credential_id" TEXT,
    "permissions" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "agent_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key_credentials" (
    "id" TEXT NOT NULL,
    "agent_identity_id" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "api_key_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" "RepositoryProvider" NOT NULL DEFAULT 'github',
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL,
    "installation_id" TEXT,
    "status" "RepositoryStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_policy_configs" (
    "id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL DEFAULT '2026-01-01',
    "sensitive_path_patterns" TEXT[],
    "production_testing_allowed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repository_policy_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "target_environments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "environment_type" "TargetEnvironmentType" NOT NULL,
    "authorization_status" "TargetAuthorizationStatus" NOT NULL DEFAULT 'pending',
    "allowed_paths" TEXT[],
    "excluded_paths" TEXT[],
    "maximum_requests" INTEGER NOT NULL,
    "maximum_concurrency" INTEGER NOT NULL,
    "destructive_testing_allowed" BOOLEAN NOT NULL DEFAULT false,
    "authorization_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "target_environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_runs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "requested_by_agent_id" TEXT NOT NULL,
    "run_type" "SecurityRunType" NOT NULL,
    "status" "SecurityRunStatus" NOT NULL DEFAULT 'queued',
    "base_sha" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "pull_request_number" INTEGER,
    "target_environment_id" TEXT,
    "policy_version" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failure_reason" TEXT,

    CONSTRAINT "security_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_classifications" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "risk_level" TEXT NOT NULL,
    "security_sensitive" BOOLEAN NOT NULL,
    "categories" TEXT[],
    "recommended_review" TEXT NOT NULL,
    "requires_preview_target" BOOLEAN NOT NULL,
    "reasons" TEXT[],
    "changed_files" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_executions" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "engine" "Engine" NOT NULL,
    "operation" TEXT NOT NULL,
    "status" "EngineExecutionStatus" NOT NULL DEFAULT 'queued',
    "input_artifact_id" TEXT,
    "output_artifact_id" TEXT,
    "engine_version" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "exit_code" INTEGER,
    "estimated_cost_usd" DECIMAL(10,4),
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "failure_reason" TEXT,

    CONSTRAINT "engine_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_decisions" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "finding_id" TEXT,
    "policy_version" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "escalate" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routing_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "findings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "cwe" TEXT,
    "severity" "FindingSeverity" NOT NULL,
    "confidence" "FindingConfidence" NOT NULL,
    "status" "FindingStatus" NOT NULL DEFAULT 'suspected',
    "discovery_engine" "DiscoveryEngine" NOT NULL DEFAULT 'deepsec',
    "finding_class" "FindingClass" NOT NULL DEFAULT 'source',
    "first_seen_commit" TEXT NOT NULL,
    "last_seen_commit" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finding_source_locations" (
    "id" TEXT NOT NULL,
    "finding_id" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "start_line" INTEGER,
    "end_line" INTEGER,
    "commit_sha" TEXT NOT NULL,
    "symbol" TEXT,

    CONSTRAINT "finding_source_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validations" (
    "id" TEXT NOT NULL,
    "finding_id" TEXT NOT NULL,
    "engine_execution_id" TEXT NOT NULL,
    "status" "ValidationStatus" NOT NULL DEFAULT 'pending',
    "target_environment_id" TEXT,
    "target_build_id" TEXT,
    "endpoint" TEXT,
    "method" TEXT,
    "evidence_summary" TEXT,
    "proof_artifact_id" TEXT,
    "validated_at" TIMESTAMP(3),

    CONSTRAINT "validations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remediations" (
    "id" TEXT NOT NULL,
    "finding_id" TEXT NOT NULL,
    "fix_commit_sha" TEXT NOT NULL,
    "source_revalidation_status" "RemediationOutcome" NOT NULL DEFAULT 'pending',
    "runtime_retest_status" "RemediationOutcome" NOT NULL DEFAULT 'pending',
    "regression_test_status" "RemediationOutcome" NOT NULL DEFAULT 'not_applicable',
    "final_status" "RemediationFinalStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "remediations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "run_id" TEXT,
    "type" "ArtifactType" NOT NULL,
    "storage_location" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "status" "ReceiptStatus" NOT NULL,
    "json_artifact_id" TEXT,
    "markdown_artifact_id" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "run_id" TEXT,
    "finding_id" TEXT,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT,
    "event_type" TEXT NOT NULL,
    "previous_state" TEXT,
    "new_state" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "event_types" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "webhook_endpoint_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "response_code" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_github_events" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_github_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_organization_id_email_key" ON "users"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_credentials_key_hash_key" ON "api_key_credentials"("key_hash");

-- CreateIndex
CREATE INDEX "api_key_credentials_agent_identity_id_idx" ON "api_key_credentials"("agent_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_organization_id_owner_name_key" ON "repositories"("organization_id", "owner", "name");

-- CreateIndex
CREATE UNIQUE INDEX "repository_policy_configs_repository_id_key" ON "repository_policy_configs"("repository_id");

-- CreateIndex
CREATE UNIQUE INDEX "security_runs_idempotency_key_key" ON "security_runs"("idempotency_key");

-- CreateIndex
CREATE INDEX "security_runs_organization_id_repository_id_idx" ON "security_runs"("organization_id", "repository_id");

-- CreateIndex
CREATE UNIQUE INDEX "run_classifications_run_id_key" ON "run_classifications"("run_id");

-- CreateIndex
CREATE INDEX "engine_executions_run_id_idx" ON "engine_executions"("run_id");

-- CreateIndex
CREATE INDEX "routing_decisions_run_id_idx" ON "routing_decisions"("run_id");

-- CreateIndex
CREATE INDEX "routing_decisions_finding_id_idx" ON "routing_decisions"("finding_id");

-- CreateIndex
CREATE UNIQUE INDEX "findings_repository_id_fingerprint_key" ON "findings"("repository_id", "fingerprint");

-- CreateIndex
CREATE INDEX "finding_source_locations_finding_id_idx" ON "finding_source_locations"("finding_id");

-- CreateIndex
CREATE INDEX "validations_finding_id_idx" ON "validations"("finding_id");

-- CreateIndex
CREATE UNIQUE INDEX "remediations_finding_id_key" ON "remediations"("finding_id");

-- CreateIndex
CREATE INDEX "artifacts_organization_id_run_id_idx" ON "artifacts"("organization_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_run_id_key" ON "receipts"("run_id");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_created_at_idx" ON "audit_events"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_run_id_idx" ON "audit_events"("run_id");

-- CreateIndex
CREATE INDEX "audit_events_finding_id_idx" ON "audit_events"("finding_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_organization_id_endpoint_idempotency_ke_key" ON "idempotency_records"("organization_id", "endpoint", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_webhook_endpoint_id_idempotency_key_key" ON "webhook_deliveries"("webhook_endpoint_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_github_events_delivery_id_key" ON "inbound_github_events"("delivery_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key_credentials" ADD CONSTRAINT "api_key_credentials_agent_identity_id_fkey" FOREIGN KEY ("agent_identity_id") REFERENCES "agent_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_policy_configs" ADD CONSTRAINT "repository_policy_configs_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "target_environments" ADD CONSTRAINT "target_environments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "target_environments" ADD CONSTRAINT "target_environments_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_runs" ADD CONSTRAINT "security_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_runs" ADD CONSTRAINT "security_runs_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_runs" ADD CONSTRAINT "security_runs_requested_by_agent_id_fkey" FOREIGN KEY ("requested_by_agent_id") REFERENCES "agent_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_runs" ADD CONSTRAINT "security_runs_target_environment_id_fkey" FOREIGN KEY ("target_environment_id") REFERENCES "target_environments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_classifications" ADD CONSTRAINT "run_classifications_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "security_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_executions" ADD CONSTRAINT "engine_executions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "security_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_executions" ADD CONSTRAINT "engine_executions_input_artifact_id_fkey" FOREIGN KEY ("input_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_executions" ADD CONSTRAINT "engine_executions_output_artifact_id_fkey" FOREIGN KEY ("output_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "security_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding_source_locations" ADD CONSTRAINT "finding_source_locations_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validations" ADD CONSTRAINT "validations_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validations" ADD CONSTRAINT "validations_engine_execution_id_fkey" FOREIGN KEY ("engine_execution_id") REFERENCES "engine_executions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validations" ADD CONSTRAINT "validations_target_environment_id_fkey" FOREIGN KEY ("target_environment_id") REFERENCES "target_environments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validations" ADD CONSTRAINT "validations_proof_artifact_id_fkey" FOREIGN KEY ("proof_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediations" ADD CONSTRAINT "remediations_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "security_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "security_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "security_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_endpoint_id_fkey" FOREIGN KEY ("webhook_endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
