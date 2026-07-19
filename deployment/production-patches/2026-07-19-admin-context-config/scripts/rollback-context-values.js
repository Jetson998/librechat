const backupId = process.env.BACKUP_ID;
if (!backupId) throw new Error('BACKUP_ID is required');
const backup = db.codexConfigBackups.findOne({ backupId });
if (!backup?.document) throw new Error('backup document is missing');
const result = db.configs.replaceOne({ _id: backup.document._id }, backup.document, { upsert: true });
if (result.matchedCount !== 1 && result.upsertedCount !== 1) {
  throw new Error('rollback did not restore the config');
}
print(`rollback_restored=${backupId}`);

