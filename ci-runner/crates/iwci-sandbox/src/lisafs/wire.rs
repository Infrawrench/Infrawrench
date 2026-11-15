//! lisafs messages as bytes.
//!
//! The layouts are gVisor's `pkg/lisafs/message.go` at the pinned release:
//! fixed-size fields in host byte order (little endian on both
//! architectures we run), packed with the explicit padding gVisor's
//! structs declare, strings as a `u16` length and the bytes, arrays as a
//! count and the elements. Every read is bounds-checked: the peer is the
//! sandbox, and nothing it sends is trusted.

/// Message ids (`MID`).
pub(crate) mod mid {
    pub const ERROR: u16 = 0;
    pub const MOUNT: u16 = 1;
    pub const CHANNEL: u16 = 2;
    pub const FSTAT: u16 = 3;
    pub const SET_STAT: u16 = 4;
    pub const WALK: u16 = 5;
    pub const WALK_STAT: u16 = 6;
    pub const OPEN_AT: u16 = 7;
    pub const OPEN_CREATE_AT: u16 = 8;
    pub const CLOSE: u16 = 9;
    pub const FSYNC: u16 = 10;
    pub const PWRITE: u16 = 11;
    pub const PREAD: u16 = 12;
    pub const MKDIR_AT: u16 = 13;
    pub const MKNOD_AT: u16 = 14;
    pub const SYMLINK_AT: u16 = 15;
    pub const LINK_AT: u16 = 16;
    pub const FSTAT_FS: u16 = 17;
    pub const FALLOCATE: u16 = 18;
    pub const READ_LINK_AT: u16 = 19;
    pub const FLUSH: u16 = 20;
    pub const UNLINK_AT: u16 = 22;
    pub const RENAME_AT: u16 = 23;
    pub const GETDENTS64: u16 = 24;
    pub const RENAME_AT2: u16 = 33;
}

/// Size of an encoded `Statx`.
pub(crate) const STATX_SIZE: usize = 144;
/// Size of an encoded `Inode`: a control FD id and its `Statx`.
pub(crate) const INODE_SIZE: usize = 8 + STATX_SIZE;

/// The peer sent something that does not decode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Malformed;

pub(crate) type Decoded<T> = Result<T, Malformed>;

/// Reads fields off the front of a message.
pub(crate) struct Reader<'a> {
    buf: &'a [u8],
}

impl<'a> Reader<'a> {
    pub(crate) fn new(buf: &'a [u8]) -> Self {
        Self { buf }
    }

    fn take(&mut self, n: usize) -> Decoded<&'a [u8]> {
        if self.buf.len() < n {
            return Err(Malformed);
        }
        let (head, rest) = self.buf.split_at(n);
        self.buf = rest;
        Ok(head)
    }

    fn array<const N: usize>(&mut self) -> Decoded<[u8; N]> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }

    #[cfg(test)]
    pub(crate) fn u8(&mut self) -> Decoded<u8> {
        Ok(self.take(1)?[0])
    }

    pub(crate) fn u16(&mut self) -> Decoded<u16> {
        Ok(u16::from_le_bytes(self.array()?))
    }

    pub(crate) fn u32(&mut self) -> Decoded<u32> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    pub(crate) fn i32(&mut self) -> Decoded<i32> {
        Ok(i32::from_le_bytes(self.array()?))
    }

    pub(crate) fn u64(&mut self) -> Decoded<u64> {
        Ok(u64::from_le_bytes(self.array()?))
    }

    pub(crate) fn i64(&mut self) -> Decoded<i64> {
        Ok(i64::from_le_bytes(self.array()?))
    }

    pub(crate) fn skip(&mut self, n: usize) -> Decoded<()> {
        self.take(n).map(|_| ())
    }

    /// A `SizedString`: a `u16` length and that many bytes.
    pub(crate) fn string(&mut self) -> Decoded<&'a [u8]> {
        let len = self.u16()? as usize;
        self.take(len)
    }

    /// A `StringArray`: a `u16` count and that many `SizedString`s.
    pub(crate) fn strings(&mut self) -> Decoded<Vec<&'a [u8]>> {
        let count = self.u16()? as usize;
        // Each needs at least its length; refuse a count the bytes cannot
        // hold before allocating for it.
        if count * 2 > self.buf.len() {
            return Err(Malformed);
        }
        (0..count).map(|_| self.string()).collect()
    }

    /// An `FdArray`: a `u16` count and that many FD ids.
    pub(crate) fn fd_ids(&mut self) -> Decoded<Vec<u64>> {
        let count = self.u16()? as usize;
        if count * 8 > self.buf.len() {
            return Err(Malformed);
        }
        (0..count).map(|_| self.u64()).collect()
    }

    /// The bytes not read yet.
    pub(crate) fn rest(&self) -> &'a [u8] {
        self.buf
    }
}

/// Builds a message.
#[derive(Default)]
pub(crate) struct Writer {
    pub(crate) buf: Vec<u8>,
}

impl Writer {
    pub(crate) fn u8(&mut self, v: u8) -> &mut Self {
        self.buf.push(v);
        self
    }

    pub(crate) fn u16(&mut self, v: u16) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }

    pub(crate) fn u32(&mut self, v: u32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }

    pub(crate) fn i32(&mut self, v: i32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }

    pub(crate) fn u64(&mut self, v: u64) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }

    pub(crate) fn i64(&mut self, v: i64) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }

    pub(crate) fn bytes(&mut self, v: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(v);
        self
    }

    /// A `SizedString`. Callers keep `v` under 64 KiB (names are at most
    /// 255 bytes, link targets at most `PATH_MAX`).
    pub(crate) fn string(&mut self, v: &[u8]) -> &mut Self {
        let len = v.len().min(u16::MAX as usize);
        self.u16(len as u16).bytes(&v[..len])
    }

    pub(crate) fn statx(&mut self, s: &Statx) -> &mut Self {
        self.u32(s.mask)
            .u32(s.blksize)
            .u64(s.attributes)
            .u32(s.nlink)
            .u32(s.uid)
            .u32(s.gid)
            .u16(s.mode)
            .u16(0)
            .u64(s.ino)
            .u64(s.size)
            .u64(s.blocks)
            .u64(s.attributes_mask);
        for t in [s.atime, s.btime, s.ctime, s.mtime] {
            self.i64(t.sec).u32(t.nsec).i32(0);
        }
        self.u32(s.rdev_major)
            .u32(s.rdev_minor)
            .u32(s.dev_major)
            .u32(s.dev_minor)
    }

    /// An `Inode`: the control FD's id and what it names.
    pub(crate) fn inode(&mut self, fd: u64, stat: &Statx) -> &mut Self {
        self.u64(fd).statx(stat)
    }
}

/// A `statx` timestamp.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Timestamp {
    pub sec: i64,
    pub nsec: u32,
}

impl Timestamp {
    pub(crate) fn from_nanos(nanos: u64) -> Self {
        Self {
            sec: (nanos / 1_000_000_000) as i64,
            nsec: (nanos % 1_000_000_000) as u32,
        }
    }
}

/// gVisor's `lisafs.Statx`, Linux's `struct statx` without the spare words.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Statx {
    pub mask: u32,
    pub blksize: u32,
    pub attributes: u64,
    pub nlink: u32,
    pub uid: u32,
    pub gid: u32,
    pub mode: u16,
    pub ino: u64,
    pub size: u64,
    pub blocks: u64,
    pub attributes_mask: u64,
    pub atime: Timestamp,
    pub btime: Timestamp,
    pub ctime: Timestamp,
    pub mtime: Timestamp,
    pub rdev_major: u32,
    pub rdev_minor: u32,
    pub dev_major: u32,
    pub dev_minor: u32,
}

impl Statx {
    /// Decodes one, for the tests' client.
    #[cfg(test)]
    pub(crate) fn read(r: &mut Reader<'_>) -> Decoded<Self> {
        let mut s = Statx {
            mask: r.u32()?,
            blksize: r.u32()?,
            attributes: r.u64()?,
            nlink: r.u32()?,
            uid: r.u32()?,
            gid: r.u32()?,
            mode: r.u16()?,
            ..Statx::default()
        };
        r.skip(2)?;
        s.ino = r.u64()?;
        s.size = r.u64()?;
        s.blocks = r.u64()?;
        s.attributes_mask = r.u64()?;
        let mut times = [Timestamp::default(); 4];
        for t in &mut times {
            t.sec = r.i64()?;
            t.nsec = r.u32()?;
            r.skip(4)?;
        }
        [s.atime, s.btime, s.ctime, s.mtime] = times;
        s.rdev_major = r.u32()?;
        s.rdev_minor = r.u32()?;
        s.dev_major = r.u32()?;
        s.dev_minor = r.u32()?;
        Ok(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_statx_is_the_size_gvisor_marshals() {
        let mut w = Writer::default();
        w.statx(&Statx::default());
        assert_eq!(w.buf.len(), STATX_SIZE);
        let mut w = Writer::default();
        w.inode(7, &Statx::default());
        assert_eq!(w.buf.len(), INODE_SIZE);
    }

    #[test]
    fn a_statx_reads_back_as_written() {
        let s = Statx {
            mask: 0x7ff,
            blksize: 4096,
            nlink: 1,
            mode: 0o100644,
            ino: 42,
            size: 1234,
            blocks: 8,
            mtime: Timestamp { sec: 5, nsec: 6 },
            dev_minor: 3,
            ..Statx::default()
        };
        let mut w = Writer::default();
        w.statx(&s);
        assert_eq!(Statx::read(&mut Reader::new(&w.buf)), Ok(s));
    }

    #[test]
    fn short_or_overlong_fields_are_refused() {
        assert_eq!(Reader::new(&[1]).u16(), Err(Malformed));
        // A string claiming more bytes than there are.
        assert_eq!(Reader::new(&[5, 0, b'a']).string(), Err(Malformed));
        // An array claiming more entries than could fit.
        assert_eq!(Reader::new(&[0xff, 0xff, 0, 0]).strings(), Err(Malformed));
        assert_eq!(Reader::new(&[0xff, 0xff, 0, 0]).fd_ids(), Err(Malformed));
        let mut r = Reader::new(&[2, 0, 1, 0, b'a', 0, 0]);
        assert_eq!(r.strings(), Ok(vec![&b"a"[..], &b""[..]]));
    }
}
