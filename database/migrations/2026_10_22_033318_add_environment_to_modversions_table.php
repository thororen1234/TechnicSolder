<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('modversions', function (Blueprint $table) {
            // "client" or "server" when the file only belongs on one side; null when it's needed on both
            $table->string('environment', 16)->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('modversions', function (Blueprint $table) {
            $table->dropColumn('environment');
        });
    }
};
