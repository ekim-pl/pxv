# Twój Pixel - szybki start

## 1 Zacznij tutaj

Ten przewodnik A5 opisuje pierwsze kroki, konfigurację, prywatność i odzyskiwanie telefonu z GrapheneOS. Faktyczne profile, aplikacje, kontrole i ograniczenia opisuje **pakiet przekazania**.

**Pakiet zawiera:** przewodnik, przyjęty raport przekazania, pisemne notatki operatora o konfiguracji i kontrolach oraz zapieczętowaną prywatną wkładkę z danymi dostępu. Porównaj etykiety zasobu na raporcie, notatkach i wkładce z telefonem. Jeśli czegoś brakuje lub etykiety się różnią, przerwij i skontaktuj się z operatorem.

1. Naładuj telefon i włącz go przyciskiem zasilania.
2. Po restarcie **najpierw odblokuj Owner (Właściciela)** zwykłym PIN-em lub hasłem. Potem przełącz się na docelowy profil i odblokuj go.
3. Połącz się z uzgodnionym Wi-Fi lub siecią komórkową. Sprawdź wymagany VPN przed otwarciem wrażliwych aplikacji.
4. Otwórz docelową aplikację, sprawdź konto i połączenie. Powtórz w każdym używanym profilu.
5. Zablokuj ekran i prywatnie sprawdź zwykłe odblokowanie. Chroń wkładkę przed wzrokiem innych.

**Przed przyjęciem telefonu** poproś o pokazanie przełączania profili i kończenia dodatkowej sesji. Sprawdź wyłączenie debugowania USB i bezprzewodowego. Odbierz rzeczywisty kontakt do wsparcia i sposób odzyskiwania dostępny bez telefonu.

**Nigdy nie testuj kodu przymusu ani klucza wymazania przez powiadomienie.** To inne dane niż zwykła blokada; mogą zniszczyć dane. Zobacz stronę 7.

<div class="page-break"></div>

## 2 Wybierz właściwy profil

Profile Androida oddzielają dane aplikacji i konta. Używaj nazw i przeznaczenia z pakietu przekazania. Telefon może nie mieć wszystkich profili opisanych w innych przewodnikach.

1. Odblokuj profil. Przesuń dwa razy w dół, otwórz Szybkie ustawienia i przełącznik użytkowników. Położenie zależy od kompilacji; użyj sposobu pokazanego przy przekazaniu.
2. Wybierz profil i wpisz **jego zwykły PIN lub hasło**. Sprawdź nazwę przed otwarciem aplikacji lub wpisaniem danych dostępu.
3. Sprawdź konto w aplikacji. Ta sama ikona w dwóch profilach nie oznacza tego samego zalogowanego konta.
4. Kończąc wrażliwą sesję dodatkowego profilu, wybierz **Zakończ sesję**, jeśli dostępne. Jeśli nie widzisz pokazanej opcji, zapytaj wsparcie. Przełączenie profilu nie kończy poprzedniej sesji.

Po restarcie odblokuj Owner przed dodatkowymi profilami. Znaj jego zwykłe dane odblokowania, nawet jeśli głównie używasz innego profilu.

**Korzystaj z przypisanych profili.** Kopiowanie plików, wspólne konta lub identyfikatory w różnych profilach mogą powiązać rozdzielane aktywności.

Wersje aplikacji są wspólne, ale dane i wiele ustawień są oddzielne. Aktualizacja może objąć kilka profili. Przed usunięciem profilu, zastąpieniem dostarczonej aplikacji lub zmianą wymaganego kierowania ruchu skontaktuj się ze wsparciem.

Usunięcie profilu niszczy jego lokalne dane. Nowy profil o tej samej nazwie ich nie przywróci. Jeśli profil znika lub nie daje się odblokować, przerwij i zgłoś problem. Nie usuwaj go ani nie odtwarzaj.

<div class="page-break"></div>

## 3 Skonfiguruj aplikacje

Wykonaj te kroki w profilach z pakietu przekazania. Ekrany zależą od wersji aplikacji. Używaj obsługiwanej konfiguracji i prywatnej metody przekazania danych uzgodnionej z operatorem.

1. **Sprawdź profil i aplikację.** Otwórz oczekiwaną aplikację. Jeśli jej brakuje lub nie wiesz, co to za aplikacja, zapytaj wsparcie przed pobraniem zamiennika.
2. **Zaloguj się lub importuj prywatnie.** Użyj właściwego konta lub konfiguracji z wkładki albo bezpiecznego magazynu. Konta innego profilu używaj tylko celowo.
3. **Dokończ wymagane kroki.** Udziel wymaganych zgód Androida i zweryfikuj konto. Przyznaj tylko potrzebne uprawnienia; pytaj, gdy cel jest niejasny.
4. **Ustaw odzyskiwanie.** Włącz MFA, jeśli dostępne. Dane odzyskiwania zachowaj w uzgodnionym bezpiecznym miejscu poza telefonem. Sprawdź dostęp bez telefonu i jego numeru.
5. **Sprawdź wynik.** Potwierdź konto i wykonaj zwykłą, nieszkodliwą czynność. W komunikatorze użyj uzgodnionego kontaktu i sprawdź powiadomienia we właściwym profilu.

Jeśli dostarczono **Session**, ma on własne ID konta komunikatora. To nie numer profilu Androida ani telefonu. Przed udostępnieniem ID sprawdź konto. Sekret odzyskiwania jest prywatny i różni się od ID, które można udostępniać.

Jeśli dostarczono **Proton VPN**, wymaga on konta i zgody Androida na VPN w każdym wymaganym profilu. Skonfiguruj go przed końcowymi ograniczeniami VPN - strona 5.

Wrażliwy import może wymagać pełnego ręcznego wpisania. W razie potrzeby poproś o ponowne prywatne przekazanie; pliki tymczasowe mogły zostać usunięte. Potwierdź operatorowi wykonanie kroku bez ujawniania sekretów.

<div class="page-break"></div>

## 4 Ustaw blokady i język

Najpierw dokończ wskazaną prywatną konfigurację aplikacji. Pracuj prywatnie w każdym profilu; zamykaj uzgodnione etapy z operatorem przed kolejnym krokiem. Początkowe dane we wkładce nie dowodzą, że bieżąca blokada działa.

1. Otwórz **Ustawienia** właściwego profilu. Jeśli menu jest inne niż pokazano, wyszukaj blokadę ekranu w ustawieniach.
2. Wpisz bieżący **zwykły** PIN lub hasło tylko na żądanie. Ustaw silną, unikalną zwykłą blokadę lub prywatnie sprawdź dostarczoną, zgodnie z ustaleniami.
3. Zablokuj ekran i odblokuj go poprawnymi zwykłymi danymi. Powtórz przed zmianą innych ustawień. Nigdy nie próbuj innych kodów z wkładki.
4. Powtórz w każdym używanym profilu, także Owner. Dostęp do odzyskiwania i zapis przypisania blokad do profili zachowaj poza telefonem.
5. Po sprawdzeniu zwykłych blokad otwórz ustawienia języka. Wybierz uzgodniony język i sprawdź go w każdym profilu.

Zmiana blokady nie aktualizuje automatycznie szyfrowanego rejestru wsparcia. Jeśli uzgodniono dalsze przechowywanie danych, użyj prywatnej metody aktualizacji z wkładki. Nie wysyłaj nowego PIN-u w zwykłym zgłoszeniu.

Biometria jest opcjonalnym ułatwieniem, jeśli obsługiwana. Znaj zwykły PIN lub hasło; są potrzebne po restarcie i przy innych żądaniach uwierzytelnienia. Nie udostępniaj ich ani nie wpisuj przy obserwatorach.

**Opcjonalny przymus konfiguruj na końcu**, po blokadach i języku. Obie wartości muszą różnić się od wszystkich faktycznych zwykłych PIN-ów i haseł profili, także zmienionych prywatnie. Poproś operatora o wyjaśnienie bez uruchamiania funkcji.

<div class="page-break"></div>

## 5 Sprawdź połączenie i VPN

Każdy profil ma własną konfigurację VPN. Połączenie w Owner nie zapewnia docelowego VPN w innym profilu. Używaj VPN i kierowania ruchu z pakietu przekazania.

1. Połącz się z uzgodnionym Wi-Fi lub sprawdź transmisję komórkową. Logowanie do sieci wykonuj tylko w uzgodnionym procesie konfiguracji.
2. We właściwym profilu otwórz dostarczony VPN. Prywatnie zaloguj się lub importuj konfigurację i zaakceptuj oczekiwaną zgodę Androida na VPN.
3. Połącz się z uzgodnioną usługą lub serwerem. Sprawdź stan VPN i połączenie docelowej aplikacji. Sama ikona nie dowodzi, że cały ruch biegnie zamierzoną trasą.
4. Gdy konfiguracja działa, poproś operatora o sprawdzenie wymaganych opcji **Zawsze włączony VPN** i **Blokuj połączenia bez VPN** w ustawieniach VPN tego profilu.
5. Powtórz w każdym profilu wymagającym VPN. Zachowaj wyłączenia z kierowania ruchu i ograniczenia testu w pakiecie przekazania.

**Jeśli aplikacje nie łączą się**, sprawdź profil, Wi-Fi/sieć komórkową, konto i połączenie VPN. W razie potrzeby połącz się ponownie przez aplikację VPN. Zapisz błąd bez haseł, kluczy i danych odzyskiwania.

Blokada połączeń bez VPN może celowo zatrzymać sieć, gdy VPN nie działa. Nie wyłączaj wymaganej ochrony ani nie usuwaj VPN, aby zaliczyć test. W razie potrzeby skontaktuj się ze wsparciem z innego urządzenia.

VPN nie zapewnia anonimowości ani nie ukrywa zalogowanego konta przed aplikacją. Witryny, aplikacje i usługa VPN mają własne zasady przetwarzania danych. Test VPN nie daje gwarancji dla każdej aplikacji i sytuacji sieciowej.

<div class="page-break"></div>

## 6 Poznaj zasady prywatności

pxv przygotowuje telefony lokalnie; nie jest usługą zdalnego zarządzania. Kontrole z pakietu przekazania opisują stan podczas przygotowania, nie stały monitoring ani gwarancję przyszłego bezpieczeństwa.

**Aplikacje i sieci mają znaczenie.** GrapheneOS i oddzielne profile nie usuwają danych dobrowolnie przekazanych aplikacji lub dostawcy konta. Sprawdzaj uprawnienia, współdzielenie kont i usługi. W razie potrzeby ukryj wrażliwą treść powiadomień na zablokowanym ekranie.

**Uzgodnij, co zachowuje wsparcie.** Uprawnione stałe wsparcie może mieć lokalny szyfrowany rejestr tożsamości i numerów telefonu, zwykłych blokad profili, ID Session, danych Proton VPN i osobno oznaczonych sekretów wymazania. Zapytaj, kto go odblokowuje i jakie są zasady aktualizacji, historii, kopii i przechowywania.

Rejestr zawiera ostatnio potwierdzone dane, nie bieżący odczyt telefonu. Prywatne zmiany mogą go zdezaktualizować. Starsze wersje mogą pozostać w szyfrowanej historii. Zmiana kodu nie usuwa dawnych kopii.

Zwykłe raporty pomijają sekrety. Prywatne pobranie na wyraźne żądanie tworzy czytelny plik: chroń go i usuń po użyciu. Papierową wkładkę odczyta każdy, kto ją zdobędzie. Przechowuj ją bezpiecznie, oddzielnie od telefonu.

**Wsparciu podawaj tylko potrzebne dane:** etykietę zasobu, profil, aplikację, czas i problem. Usuwaj sekrety i prywatne wiadomości ze zrzutów ekranu. Dane dostępu aktualizuj uzgodnioną prywatną metodą, nigdy w publicznym zgłoszeniu ani zwykłej notatce wsparcia.

Rzeczywisty kontakt do wsparcia, uzgodnienia o zachowanych danych i prywatna metoda aktualizacji należą do wkładki. Przykładowe kontakty w oprogramowaniu lub dokumentacji nie określają Twoich warunków obsługi.

<div class="page-break"></div>

## 7 Dbaj o bezpieczeństwo

**Aktualizuj oprogramowanie.** Pozostaw włączone automatyczne aktualizacje systemu i uruchamiaj telefon ponownie na żądanie. Używaj systemowego aktualizatora i uzgodnionych zaufanych źródeł aplikacji. Przestrzegaj planu obsługi i zarządzanych aplikacji z pakietu przekazania; zgłaszaj błędy wymaganych aktualizacji. Miej dostęp do zwykłych danych odblokowania.

**Chroń dostęp.** Blokuj telefon bez nadzoru. Po konfiguracji i serwisie wyłącz obie opcje debugowania. Nie zatwierdzaj nieoczekiwanych próśb debugowania USB. Zapytaj wsparcie przed zmianami bootloadera, resetem fabrycznym, naprawą, ponowną instalacją systemu lub przekazaniem innej osobie.

**Sprawdzaj uprawnienia.** Aparat, mikrofon, lokalizację, kontakty i pliki udostępniaj tylko w razie potrzeby. Używaj kontroli uprawnień. Gdy aplikacja przestanie działać po zmianie, zgłoś ją zamiast przyznawać wszystkie uprawnienia.

**Poznaj wymazywanie przed konfiguracją.** Opcjonalne dane przymusu GrapheneOS, wpisane w odpowiednim żądaniu uwierzytelnienia, nieodwracalnie wymazują **cały telefon, wszystkie profile i zainstalowane eSIM-y**. To nie dodatkowe kody odblokowania. Oddziel je od codziennych danych i nigdy ich nie testuj.

Opcjonalny **klucz wymazania przez powiadomienie Oblivion** to osobny sekret konkretnej instalacji aplikacji i profilu. pxv nie potwierdziło wymaganego wymazania całego telefonu dla konkretnej aplikacji i kompilacji. Nie polegaj na gwarantowanym zdalnym wymazaniu. Nigdy nie wysyłaj klucza podczas konfiguracji, pokazu ani wsparcia.

Wymazywanie konfiguruj tylko w uzgodnionym nadzorowanym procesie, po blokadach i języku. Przewodnik ani rejestr wsparcia nie uruchamiają wymazania. Jeśli ekran lub typ danych jest niejasny, przerwij przed wpisaniem czegokolwiek.

<div class="page-break"></div>

## 8 Odzyskiwanie i wsparcie

**Rób kopie każdego używanego profilu.** Uzgodnij obsługiwany przez system/aplikację sposób kopii lub eksportu, zakres danych, miejsce, częstotliwość i wyłączenia. Kopia Owner nie obejmuje automatycznie innych profili i aplikacji. Komunikat o sukcesie nie oznacza sprawdzonego odtworzenia.

Dane odzyskiwania trzymaj bezpiecznie poza telefonem. Jeśli dostępne jest osobne uprawnione urządzenie testowe, poproś o reprezentatywną próbę odtworzenia. Nie wymazuj tego telefonu, nie usuwaj profilu ani nie odblokowuj bootloadera, aby testować odzyskiwanie.

**Po utracie telefonu** skontaktuj się ze wsparciem z innego zaufanego urządzenia. Sprawdź sesje kont, hasła i odzyskiwanie u dostawców usług. Szyfrowany rejestr nie zlokalizuje ani nie odzyska telefonu. Nie zakładaj dostępności zdalnego wymazania.

**Jeśli zapomnisz blokady**, nie zgaduj innych kodów. Użyj zapisanej ścieżki wsparcia. Odzyskanie dostępu nie jest gwarantowane; może zależeć od bieżących danych i kopii. Destrukcyjne odzyskiwanie zatwierdź dopiero po zrozumieniu utraty danych.

Przed odbiorem potwierdźcie razem:

- Etykiety telefonu, raportu, notatek i wkładki są zgodne.
- Każdy profil otwiera się zwykłą blokadą; aplikacje i VPN działają w zapisanym zakresie testu.
- Debugowanie USB i bezprzewodowe są wyłączone; ograniczenia zapisano w pakiecie przekazania.
- Masz kontakt do wsparcia, prywatną metodę aktualizacji i odzyskiwanie poza telefonem.
- Wkładka jest zapieczętowana, a strona wymazania oddzielona. Przechowuj je bezpiecznie z dala od telefonu.

**Oficjalne źródła:** [obsługa](https://grapheneos.org/usage), [funkcje](https://grapheneos.org/features), [FAQ](https://grapheneos.org/faq). Faktyczną konfigurację i kontrole określa Twój pakiet przekazania.
