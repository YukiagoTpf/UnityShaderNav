Shader "Test/Nested" {
  SubShader {
    Pass {
      HLSLPROGRAM
      struct Foo { float a; struct Bar { float b; }; };
      void f() { { { } } }
      ENDHLSL
    }
  }
}
