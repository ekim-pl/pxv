# Przygotowany Pixel: przewodnik odbiorcy

Ten przewodnik pomaga odebrać i używać Pixela z GrapheneOS oraz kilkoma profilami użytkowników Androida. Pakiet przekazania opisuje profile i kontrole **Twojego telefonu**. Nazwy aplikacji i położenie opcji zależą od sprawdzonej konfiguracji i zainstalowanej kompilacji.

**Przed codziennym użyciem:** sprawdź etykietę telefonu, poznaj przeznaczenie profili, zweryfikuj zwykłe blokady, dokończ prywatną konfigurację aplikacji i odbierz instrukcje wsparcia oraz odzyskiwania. Nigdy nie sprawdzaj działania przez użycie kodu lub klucza wymazującego dane.

Osobna [instrukcja A5](quickstart-pl.md) jest przeznaczona do dołączenia do każdego telefonu. Osoba przygotowująca urządzenie przekazuje zamkniętą, prywatnie wypełnioną [wkładkę z danymi dostępu](credentials-pl.md) z pasującym identyfikatorem telefonu. Po odbiorze przechowuj ją bezpiecznie, oddzielnie od telefonu; opcjonalna strona z kodami wymazującymi dane jest oddzielona od zwykłych danych odblokowania.

## 1. Sprawdź odbierany telefon

Razem z operatorem potwierdź:

1. Fizyczny telefon odpowiada etykiecie w pakiecie przekazania.
2. Każdy uzgodniony profil istnieje, otwiera się i zawiera właściwe aplikacje oraz język.
3. Wiesz, jak odblokować każdy profil jego zwykłym PIN-em lub hasłem.
4. Wymagane konta aplikacji, połączenia VPN i metody odzyskiwania zostały sprawdzone albo ich ograniczenia zapisano.
5. Po przygotowaniu fizycznie wyłączono debugowanie USB i debugowanie bezprzewodowe.
6. Masz rzeczywisty kontakt do operatora, uzgodnione miejsce kopii i sposób odzyskania dostępu bez tego telefonu.

Zgłoś brakujące aplikacje, niedziałające połączenia lub nieoczekiwane dane przed przyjęciem telefonu. Ogólny przewodnik ani dawny wynik testu nie dowodzą, że Twoje urządzenie przeszło kontrole. Operator osobno zapisuje finalizację i potwierdzenie przejęcia telefonu.

## 2. Korzystaj z właściwego profilu

Otwórz przełącznik użytkowników Androida i wybierz profil wskazany w pakiecie przekazania. Poproś operatora o pokazanie przełączania, blokowania i kończenia sesji dodatkowego użytkownika na tej kompilacji.

Wykonuj czynności osobiste, służbowe, testowe lub inne uzgodnione zadania we właściwych profilach. Dane aplikacji i konfiguracja konta należą do profilu, w którym zostały wprowadzone. Instalacja aplikacji w kilku profilach nie loguje ich automatycznie na to samo konto.

Wersje pakietów aplikacji są wspólne dla telefonu, a dane użytkowników i wiele ustawień pozostają oddzielne. Aktualizacja lub zmiana pakietu może objąć kilka profili. Przed usunięciem profilu, zastąpieniem zarządzanej aplikacji lub zmianą wymaganego VPN skontaktuj się ze wsparciem.

Widoczna nazwa profilu nie jest trwałym identyfikatorem konta. Po usunięciu Android może ponownie użyć numeru użytkownika; wsparcie śledzi również jego numer seryjny. Nie odtwarzaj brakującego profilu pod tą samą nazwą z założeniem, że dawny wpis nadal pasuje.

## 3. Dokończ prywatną konfigurację we właściwej kolejności

Operator może zatrzymać przygotowanie, aby umożliwić Ci prywatne czynności na telefonie. Wykonuj wskazany etap zamiast przypadkowej kolejności działań.

1. Na żądanie dokończ zwykłą konfigurację aplikacji: logowanie, import, MFA i zgody Androida. Przed wpisaniem danych sprawdź profil.
2. Ustaw lub sprawdź **zwykłą blokadę ekranu w każdym uzgodnionym profilu**. Jeśli przekazano początkowy PIN lub hasło, prywatnie je zweryfikuj albo zmień zgodnie z ustaleniami. Sprawdź zwykłe zablokowanie i odblokowanie poprawną wartością.
3. Po sprawdzeniu zwykłych blokad ustaw i zweryfikuj docelowy język każdego profilu.
4. Dopiero po blokadach i języku skonfiguruj opcjonalny przymus GrapheneOS. Obie wartości przymusu muszą różnić się od wszystkich rzeczywistych zwykłych PIN-ów i haseł profili, także zmienionych prywatnie.

Nigdy nie wpisuj wartości przymusu w zwykłym ekranie odblokowania ani uwierzytelnienia. Nie uruchamiaj destrukcyjnego przymusu w ramach odbioru. Jeśli nie wiesz, jakiej wartości żąda ekran, zatrzymaj się i zapytaj przed wpisaniem.

Wartości początkowe służą tylko do inicjalizacji. Poprawne wykonanie polecenia nie dowodzi, że potrafisz odblokować profil. Zmiana na telefonie nie aktualizuje automatycznie rejestru wsparcia.

Poinformuj operatora o zakończeniu wskazanego etapu bez wypowiadania, pokazywania ani zapisywania sekretów w publicznych notatkach. Jeśli uprawnione wsparcie zachowuje aktualne dane, przekaż zmianę uzgodnionym prywatnym sposobem opisanym poniżej.

## 4. Skonfiguruj aplikacje i VPN w każdym profilu

Używaj obsługiwanej przez aplikację metody logowania, importu konfiguracji i odzyskiwania. Wrażliwe importy przekazuj zatwierdzoną prywatną metodą. Jeżeli automatyzacja nie jest obsługiwana, wykonaj całą konfigurację prywatnie; nie szukaj wygasłego pliku tymczasowego z wcześniejszej próby.

VPN wymaga własnej konfiguracji i zgody Androida w każdym profilu, w którym jest potrzebny. Dokończ to przed włączeniem przez operatora stałego VPN lub blokowania połączeń bez VPN. Następnie sprawdź zamierzone połączenie i aplikacje.

Gdy sieć przestanie działać, sprawdź profil, konfigurację oczekiwanej aplikacji VPN i dostępność uzgodnionej sieci. Zgłoś profil, aplikację i widoczny błąd bez danych uwierzytelniających. Nie usuwaj VPN ani jego zabezpieczeń tylko po to, aby zaliczyć test.

Wynik pomocnika obejmuje wyłącznie zapisany zakres kontroli. Nie gwarantuje tej samej trasy całego ruchu aplikacji. Zachowaj ograniczenia w pakiecie przekazania i konsultuj zmiany tras, kopii i uprawnień.

## 5. Rozróżniaj Session, Oblivion i przymus

**Identyfikator komunikatora Session** wskazuje konto komunikatora. Nie jest identyfikatorem profilu Androida, numerem użytkownika, numerem telefonu ani numerem seryjnym sprzętu. Przed udostępnieniem ID sprawdź, do którego konta i profilu należy.

**Klucz wymazania przez powiadomienie Oblivion** należy do instalacji aplikacji w konkretnym profilu Androida. Użytkownik opisał wymagane zachowanie jako wymazanie **całego telefonu**, gdy klucz znajdzie się w odebranym powiadomieniu. Projekt nie zakwalifikował tego zachowania dla sprawdzonej, konkretnej aplikacji i kompilacji.

Traktuj prawdziwy klucz Oblivion jako destrukcyjny sekret. Przechowuj go oddzielnie od PIN-u i hasła przymusu GrapheneOS. Nie wysyłaj go podczas przygotowania, testów odbiorczych ani zwykłego wsparcia; nie umieszczaj go na zrzutach ekranu, w logach i publicznych eksportach. Celowe wymazanie wymaga osobnej, uzgodnionej procedury. Dostęp do rejestru nie wysyła powiadomienia i nie uruchamia wymazania.

Jeżeli nie rozumiesz funkcji usuwania danych lub jej zakresu, pozostaw konfigurację uzgodnionej procedurze nadzorowanej. Odbiór i sprawdzenie telefonu nie wymagają rzeczywistego wymazania.

## 6. Ustal zasady zachowania danych przez wsparcie

W ramach uprawnionego stałego wsparcia operator może zachowywać ostatnio potwierdzone dane w **lokalnym szyfrowanym rejestrze**. Uzgodnij, kto go odblokowuje, jakie dane pozostają, jak zgłaszać zmiany i jak chronione są prywatne kopie.

Wpis może zawierać:

- Tożsamość telefonu: etykietę zasobu, numer seryjny sprzętu, codename Pixela i numer telefonu.
- Parę PIN/hasło przymusu GrapheneOS dla urządzenia, oddzielną od Oblivion.
- PIN/hasło, klucz Oblivion, identyfikator Session, login/hasło Proton VPN i opcjonalny numer telefonu każdego profilu.
- Trwałe tożsamości profili Androida i zaszyfrowane rewizje historyczne.

`current` oznacza ostatnie jawne potwierdzenie operatora, a nie ciągły odczyt z telefonu. `initial`, `unknown` i `stale` to osobne stany. Po zmianie zachowywanego hasła, kodu lub konta uzgodnij prywatną aktualizację, aby wsparcie nie polegało na starej wartości.

Flashowanie, tworzenie profilu, niektóre początkowe zapisy blokady i zdarzenia serwisowe mogą oznaczyć odpowiednie dane jako nieaktualne. Poprzednie rewizje pozostają zaszyfrowaną historią. Dawna pobrana wartość nie jest dowodem, że nadal odblokowuje telefon.

Zwykłe raporty i pakiety przekazania pomijają wartości rejestru. Prywatne pobranie celowo tworzy plik jawny, który trzeba chronić i usunąć po użyciu. Kopie rejestru i dane do ich odblokowania wymagają osobnej ochrony; operator może zmienić hasło szyfrowania. Przeczytaj [szczegóły rejestru](../../../docs/PHONE_REGISTRY.md) i [zasady bezpieczeństwa](../../../SECURITY.md).

## 7. Zachowuj dane możliwe do odtworzenia

Uzgodnij zakres kopii **w każdym profilu**, miejsce przechowywania, opiekuna danych odzyskiwania i wyłączenia. Instalacja aplikacji, włączona kopia lub powiadomienie o sukcesie nie stanowią sprawdzonego odtworzenia.

Używaj ustalonej z operatorem metody kopii lub eksportu obsługiwanej przez dany system i aplikację. Zapewnij dostęp do odzyskiwania bez tego telefonu, jego numeru i MFA. Nie zakładaj, że kopia właściciela obejmuje każdy dodatkowy profil i aplikację.

Jeżeli dostępny jest osobny, zatwierdzony telefon testowy, poproś o reprezentatywną próbę odtworzenia. Nie wymazuj podstawowego telefonu, nie usuwaj profilu i nie odblokowuj bootloadera tylko po to, aby sprawdzić kopię. Poznaj zapisane wyłączenia przed poleganiem na odzyskiwaniu.

## 8. Zgłaszaj problemy bez ujawniania sekretów

Podaj etykietę zasobu, profil, aplikację, czas i opis problemu. Sekrety przekazuj wyłącznie uzgodnioną prywatną ścieżką aktualizacji rejestru; zwykłe zgłoszenia i zrzuty ekranu powinny je pomijać.

Skontaktuj się z operatorem przed naprawą, usunięciem profilu, resetem fabrycznym, ponowną instalacją systemu lub przekazaniem innej osobie. Zmiany wymagają nowych kontroli tożsamości i mogą unieważnić poprzednie przekazanie. Po utracie telefonu zastosuj uzgodnioną procedurę i sprawdź powiązane konta usług; sam wpis rejestru nie odzyska urządzenia.

Podczas serwisu pod nadzorem może być potrzebne tymczasowe debugowanie. Po zakończeniu ponownie sprawdź wyłączenie obu opcji, uzgodnij zmienione dane i odbierz nowe potwierdzenie przekazania, jeśli jest wymagane.

## Dalsze instrukcje i zakres weryfikacji

[Przewodnik operatora](operator-pl.md) opisuje polecenia i odbiór. Dokumentacja techniczna obejmuje [zależności komputera](../../../docs/HOST_DEPENDENCIES.md), [format polityki](../../../docs/POLICY_FORMAT.md), [listę poleceń](../../../docs/COMMAND_REFERENCE.md), [kopie i odzyskiwanie](../../../docs/CANARY_BACKUP_RECOVERY.md), [automatyzację](../../../docs/AUTOMATION.md) i [Dockera](../../../docs/DOCKER.md).

[Stan weryfikacji](../../../docs/VERIFICATION.md) określa granice zachowanych dowodów. Próba offline i historyczny wynik telefonu nie kwalifikują bieżącej konfiguracji. Bez fizycznego telefonu testowego instalacja, aplikacje, VPN i odzyskiwanie pozostają niezakwalifikowane do czasu rzeczywistych kontroli na uprawnionym urządzeniu.
