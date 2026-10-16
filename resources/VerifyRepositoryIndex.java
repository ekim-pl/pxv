import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.security.CodeSigner;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.Enumeration;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/** Verify the actual JSON entry, including its signer, before emitting any bytes. */
public final class VerifyRepositoryIndex {
    public static void main(String[] args) {
        try {
            if ((args.length != 2 && args.length != 3) || !args[1].matches("[0-9a-fA-F]{64}")) throw new IllegalArgumentException();
            String name = args.length == 3 ? args[2] : "index-v1.json";
            if (!name.equals("entry.json") && !name.equals("index-v1.json")) throw new IllegalArgumentException();
            int limit = name.equals("entry.json") ? 1024 * 1024 : 64 * 1024 * 1024;
            long jarLimit = name.equals("entry.json") ? 4 * 1024 * 1024 : 32 * 1024 * 1024;
            if (new File(args[0]).length() > jarLimit) throw new SecurityException("JAR too large");
            try (JarFile jar = new JarFile(new File(args[0]), true)) {
                int count = 0;
                Enumeration<JarEntry> entries = jar.entries();
                while (entries.hasMoreElements()) if (name.equals(entries.nextElement().getName())) count++;
                if (count != 1) throw new SecurityException("Missing or duplicate index entry");
                JarEntry entry = jar.getJarEntry(name);
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                try (InputStream input = jar.getInputStream(entry)) {
                    byte[] buffer = new byte[8192];
                    int length;
                    while ((length = input.read(buffer)) != -1) {
                        if (output.size() + length > limit) throw new SecurityException("Index too large");
                        output.write(buffer, 0, length);
                    }
                }
                // Reading to EOF is essential: JarFile only establishes entry
                // signers after its content digest has been verified.
                CodeSigner[] signers = entry.getCodeSigners();
                if (signers == null || signers.length != 1) throw new SecurityException("Unsigned or ambiguous index");
                X509Certificate certificate = (X509Certificate) signers[0].getSignerCertPath().getCertificates().get(0);
                certificate.checkValidity();
                byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
                StringBuilder fingerprint = new StringBuilder();
                for (byte value : digest) fingerprint.append(String.format("%02x", value & 0xff));
                if (!fingerprint.toString().equalsIgnoreCase(args[1])) throw new SecurityException("Signer does not match pin");
                System.out.write(output.toByteArray());
            }
        } catch (Exception failure) {
            System.err.println("Repository index verification failed: " + failure.getClass().getSimpleName());
            System.exit(2);
        }
    }
}
