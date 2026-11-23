use super::super::common::FileChunkReference64x32;
use crate::Reader;
use crate::errors::{ErrorKind, Result};
use crate::onestore::desktop::parse::{Parse, ParseWithCount};
use onenote_parser_macros::Parse;

/// See [\[MS-ONESTORE\] 2.3.3.1](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-onestore/158030a2-dbf0-4b92-bf6e-1a91a403aebd)
#[derive(Debug)]
#[allow(dead_code)]
pub(crate) struct TransactionLogFragment {
    pub(crate) size_table: Vec<TransactionEntry>,
    pub(crate) next_fragment: FileChunkReference64x32,
}

impl ParseWithCount for TransactionLogFragment {
    fn parse(reader: Reader, size: usize) -> Result<Self> {
        let mut all = usize::MAX;
        Self::parse_limited(reader, size, &mut all)
    }
}

impl TransactionLogFragment {
    /// Parse a fragment, reading at most `transactions` more transactions (decremented as they are
    /// read). Per [MS-ONESTORE] 2.3.1 only the first cTransactionsInLog transactions are valid: what
    /// follows the last one is stale data from earlier saves, including a stale next_fragment.
    pub(crate) fn parse_limited(reader: Reader, size: usize, transactions: &mut usize) -> Result<Self> {
        let size_table_count = (size - 12) / 8;
        let mut size_table = Vec::new();
        let mut last_was_sentinel = false;
        let mut i = 0;
        while i < size_table_count && *transactions > 0 {
            let entry = TransactionEntry::parse(reader)?;
            i += 1;

            if entry.is_sentinel() {
                last_was_sentinel = true;
                *transactions -= 1;
            } else {
                last_was_sentinel = false;
                size_table.push(entry);
            }
        }
        if *transactions == 0 {
            // the log ends here: nothing after the last valid transaction is read
            return Ok(Self { size_table, next_fragment: FileChunkReference64x32::nil() });
        }

        // According to \[MS-ONESTORE\] 2.3.3.1, the size_table should terminate with a
        // sentinel entry.
        if size_table_count > 0 && !last_was_sentinel {
            return Err(
                ErrorKind::MalformedOneStoreData(
                    format!(
                        "The size_table must end in a sentinel entry. Total entries: {}. Last entry: {:?}",
                        size_table_count,
                        size_table[size_table_count - 1]
                    ).into()
                ).into()
            );
        }

        Ok(Self {
            size_table,
            next_fragment: FileChunkReference64x32::parse(reader)?,
        })
    }
}

/// See [\[MS-ONESTORE\] 2.3.3.2](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-onestore/c00897d9-d90a-4707-b9fb-58c93e490322)
#[derive(Debug, Parse)]
#[allow(dead_code)]
pub(crate) struct TransactionEntry {
    pub(crate) src_id: u32,
    pub(crate) transaction_entry_switch: u32,
}

impl TransactionEntry {
    pub(crate) fn is_sentinel(&self) -> bool {
        self.src_id == 0x00000001
    }
}
