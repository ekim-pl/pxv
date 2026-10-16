use std::io;
pub(crate) fn failure(message: impl ToString) -> io::Error {
    io::Error::other(message.to_string())
}
