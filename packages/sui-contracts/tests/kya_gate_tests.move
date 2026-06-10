#[test_only]
module fhe_brain::kya_gate_tests {
    use fhe_brain::kya_gate;

    #[test]
    fun test_verify_passes_above_threshold() {
        let claim = kya_gate::new_claim(b"agent-0xabc", 80, b"signed-proof");
        assert!(kya_gate::verify(&claim, 50), 0);
        assert!(kya_gate::verify(&claim, 80), 1);
    }

    #[test]
    fun test_verify_fails_below_threshold() {
        let claim = kya_gate::new_claim(b"agent-0xabc", 30, b"signed-proof");
        assert!(!kya_gate::verify(&claim, 50), 0);
    }

    #[test]
    fun test_verify_fails_empty_proof() {
        let claim = kya_gate::new_claim(b"agent-0xabc", 100, b"");
        assert!(!kya_gate::verify(&claim, 0), 0);
    }
}
