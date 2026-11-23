# onenote_parser 2.1.0, patched for goodink

From crates.io (MPL-2.0, https://github.com/msiemens/onenote.rs). goodink imports OneNote notebooks
with it (src-tauri/src/onenote.rs). Upstream 2.1.0 failed on about half of the real OneNote 2016
desktop sections we tried (larger, often-edited ones); three fixes, all in `src/onestore/desktop`:

1. `file_node/mod.rs`: a node's element list that is fcrNil/fcrZero (empty) is no list, instead of
   resolving it to a zero-length slice and failing with UnexpectedEof.
2. `one_store_file.rs`, `file_structure/transaction_log_fragment.rs`: read only the header's
   cTransactionsInLog transactions ([MS-ONESTORE] 2.3.1). What follows is stale data from earlier
   saves, whose next-fragment reference points far past the end of the file.
   Also: a free chunk list that cannot be read is skipped (free space is never used).
3. `file_structure/file_node_list_fragment.rs`: ChunkTerminatorFND ends a fragment's nodes
   ([MS-ONESTORE] 2.4.2), and the size arithmetic no longer underflows (a panic before).

Worth sending upstream. To update: copy the new release here and re-apply these.
