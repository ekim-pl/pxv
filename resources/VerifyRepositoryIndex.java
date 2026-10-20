import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.CodeSigner;
import java.security.MessageDigest;
import java.security.Security;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.Enumeration;
import java.util.stream.Collectors;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/** Verify the actual JSON entry, including its signer, before emitting any bytes. */
public final class VerifyRepositoryIndex {
    private static String indexName(String[] args) {
        if ((args.length < 2 || args.length > 4) || !args[1].matches("[0-9a-fA-F]{64}")) {
            throw new IllegalArgumentException();
        }
        String name = args.length >= 3 ? args[2] : "index-v1.json";
        if (!name.equals("entry.json") && !name.equals("index-v1.json")) throw new IllegalArgumentException();
        return name;
    }

    private static JarEntry uniqueEntry(JarFile jar, String name) {
        int count = 0;
        Enumeration<JarEntry> entries = jar.entries();
        while (entries.hasMoreElements()) {
            if (name.equals(entries.nextElement().getName())) count++;
        }
        if (count != 1) throw new SecurityException("Missing or duplicate index entry");
        return jar.getJarEntry(name);
    }

    private static byte[] contents(JarFile jar, JarEntry entry, int limit) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (InputStream input = jar.getInputStream(entry)) {
            byte[] buffer = new byte[8192];
            int length;
            while ((length = input.read(buffer)) != -1) {
                if (output.size() + length > limit) throw new SecurityException("Index too large");
                output.write(buffer, 0, length);
            }
        }
        return output.toByteArray();
    }

    private static void verifySigner(JarEntry entry, String pin) throws Exception {
        // JarFile establishes signers only after reading and verifying content to EOF.
        CodeSigner[] signers = entry.getCodeSigners();
        if (signers == null || signers.length != 1) throw new SecurityException("Unsigned or ambiguous index");
        X509Certificate certificate = (X509Certificate) signers[0].getSignerCertPath().getCertificates().get(0);
        certificate.checkValidity();
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
        StringBuilder fingerprint = new StringBuilder();
        for (byte value : digest) fingerprint.append(String.format("%02x", value & 0xff));
        if (!fingerprint.toString().equalsIgnoreCase(pin)) throw new SecurityException("Signer does not match pin");
    }

    private static void v1Compatibility(String name, boolean fileOutput) {
        if (!fileOutput || !name.equals("index-v1.json")) return;
        // fdroidcl's v1 protocol still uses SHA1withRSA. Keep every other JAR restriction
        // and confine compatibility to this short-lived verifier with an exact certificate pin.
        String disabled = Security.getProperty("jdk.jar.disabledAlgorithms");
        String restricted = Arrays.stream(disabled.split(","))
            .filter(rule -> !rule.trim().matches("(?i)SHA-?1(?:\\s.*)?"))
            .collect(Collectors.joining(","));
        Security.setProperty("jdk.jar.disabledAlgorithms", restricted);
    }

    public static void main(String[] args) {
        try {
            String name = indexName(args);
            boolean fileOutput = args.length == 4;
            v1Compatibility(name, fileOutput);
            int limit = name.equals("entry.json") ? 1024 * 1024 : (fileOutput ? 128 : 64) * 1024 * 1024;
            long jarLimit = name.equals("entry.json") ? 4 * 1024 * 1024 : 32 * 1024 * 1024;
            if (new File(args[0]).length() > jarLimit) throw new SecurityException("JAR too large");
            try (JarFile jar = new JarFile(new File(args[0]), true)) {
                JarEntry entry = uniqueEntry(jar, name);
                byte[] output = contents(jar, entry, limit);
                verifySigner(entry, args[1]);
                if (fileOutput) {
                    Files.write(Path.of(args[3]), output, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
                } else {
                    System.out.write(output);
                }
            }
        } catch (Exception failure) {
            System.err.println("Repository index verification failed: " + failure.getClass().getSimpleName());
            System.exit(2);
        }
    }
}
