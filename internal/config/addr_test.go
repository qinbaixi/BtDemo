package config

import "testing"

func TestNormalizeAddr(t *testing.T) {
	for input, want := range map[string]string{"": ":8080", "8090": ":8090", " :9000 ": ":9000", "127.0.0.1:7000": "127.0.0.1:7000"} {
		if got := NormalizeAddr(input); got != want {
			t.Errorf("NormalizeAddr(%q) = %q, want %q", input, got, want)
		}
	}
}
