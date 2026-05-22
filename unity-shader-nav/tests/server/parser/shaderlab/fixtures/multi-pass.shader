Shader "Test/MultiPass" {
  SubShader {
    Pass {
      Name "ForwardLit"
      HLSLPROGRAM
      void vert() {}
      ENDHLSL
    }
    Pass {
      Name "ShadowCaster"
      HLSLPROGRAM
      void vert() {}
      ENDHLSL
    }
  }
}
