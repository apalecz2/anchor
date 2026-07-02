use rust_xlsxwriter::{Format, Workbook};

/// Write a string grid to an XLSX file. Row 0 is treated as the header and rendered bold.
/// Runs off the async runtime (`spawn_blocking`-equivalent via `tauri::command` on a sync
/// fn) since `rust_xlsxwriter` is a synchronous, CPU-bound writer.
#[tauri::command]
pub fn export_xlsx(rows: Vec<Vec<String>>, dest_path: String) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    let header_format = Format::new().set_bold();

    for (row_idx, row) in rows.iter().enumerate() {
        let row_num = u32::try_from(row_idx).map_err(|_| "too many rows for XLSX".to_string())?;
        for (col_idx, cell) in row.iter().enumerate() {
            let col_num =
                u16::try_from(col_idx).map_err(|_| "too many columns for XLSX".to_string())?;
            let result = if row_idx == 0 {
                worksheet.write_string_with_format(row_num, col_num, cell, &header_format)
            } else {
                worksheet.write_string(row_num, col_num, cell)
            };
            result.map_err(|e| e.to_string())?;
        }
    }

    worksheet.autofit();
    workbook.save(&dest_path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_valid_xlsx_with_header_and_data_rows() {
        let dir = std::env::temp_dir();
        let path = dir.join("export_xlsx_smoke_test.xlsx");
        let path_str = path.to_string_lossy().to_string();

        let rows = vec![
            vec!["Name".to_string(), "Age".to_string()],
            vec!["Al".to_string(), "30".to_string()],
        ];

        export_xlsx(rows, path_str.clone()).expect("export should succeed");
        let bytes = std::fs::read(&path).expect("file should exist");
        // XLSX files are zip archives -> start with the local file header magic bytes.
        assert_eq!(&bytes[0..2], b"PK");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_more_than_u16_max_columns() {
        let dir = std::env::temp_dir();
        let path = dir.join("export_xlsx_toowide_test.xlsx");
        let path_str = path.to_string_lossy().to_string();

        let too_wide_row: Vec<String> = (0..(u16::MAX as usize + 1)).map(|i| i.to_string()).collect();
        let rows = vec![too_wide_row];

        let result = export_xlsx(rows, path_str);
        assert!(result.is_err());
    }
}
