fn count_markdown_files_in_vault(canonical_vault: &Path) -> usize {
    WalkDir::new(canonical_vault)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.into_path())
        .filter(|path| path.is_file() && is_markdown_file(path))
        .count()
}

fn vault_index_row_counts(conn: &Connection, vault_root: &str) -> Result<(i64, i64), String> {
    let indexed_chunks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM retrieval_chunks WHERE entity_type = 'vault_note' AND project_root = ?1",
            params![vault_root],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let indexed_files: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT entity_id) FROM retrieval_chunks WHERE entity_type = 'vault_note' AND project_root = ?1",
            params![vault_root],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok((indexed_chunks, indexed_files))
}

fn vault_index_needs_rebuild(
    conn: &Connection,
    canonical_vault: &Path,
    vault_root: &str,
) -> Result<bool, String> {
    let (indexed_chunks, indexed_files) = vault_index_row_counts(conn, vault_root)?;
    let markdown_file_count = count_markdown_files_in_vault(canonical_vault) as i64;

    if markdown_file_count == 0 {
        // If there are no markdown files anymore but index rows still exist, rebuild to clear stale rows.
        return Ok(indexed_chunks > 0 || indexed_files > 0);
    }

    if indexed_chunks == 0 || indexed_files == 0 {
        return Ok(true);
    }

    Ok(indexed_files != markdown_file_count)
}

pub fn ensure_vault_index_ready(app: &AppHandle, vault_path: &str) -> Result<VaultIndexStats, String> {
    let canonical_vault = fs::canonicalize(vault_path).map_err(|e| format!("Invalid vault path: {e}"))?;
    let vault_root = canonical_vault.to_string_lossy().to_string();
    let conn = crate::intent::db::open(app)?;

    if vault_index_needs_rebuild(&conn, &canonical_vault, &vault_root)? {
        return reindex_markdown_vault(app, vault_path);
    }

    let (indexed_chunks, indexed_files) = vault_index_row_counts(&conn, &vault_root)?;
    Ok(VaultIndexStats {
        indexed_files: indexed_files as usize,
        indexed_chunks: indexed_chunks as usize,
        vault_path: vault_root,
        cancelled: false,
    })
}
