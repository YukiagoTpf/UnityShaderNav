Shader "Test/Inc" {
  HLSLINCLUDE
  float4 Shared(float4 x) { return x; }
  ENDHLSL

  SubShader {
    Pass {
      HLSLPROGRAM
      void main() {}
      ENDHLSL
    }
  }
}
