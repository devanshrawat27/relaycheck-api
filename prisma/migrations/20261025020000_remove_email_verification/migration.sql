-- DropIndex
DROP INDEX "users_email_verification_token_hash_key";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "email_verification_token_hash",
DROP COLUMN "email_verified_at";
