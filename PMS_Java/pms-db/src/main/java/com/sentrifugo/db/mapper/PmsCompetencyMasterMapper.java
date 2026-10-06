package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsCompetencyMasterDTO;
import com.sentrifugo.db.entity.PmsCompetencyMasterEntity;
import org.mapstruct.Builder;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingTarget;
import org.mapstruct.NullValuePropertyMappingStrategy;
import org.mapstruct.ReportingPolicy;

import java.util.List;

@Mapper(
        componentModel = "spring",
        unmappedTargetPolicy = ReportingPolicy.IGNORE,
        nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE,
        // Lombok @SuperBuilder entities/DTOs: map through constructor + setters (see PmsCycleMapper).
        builder = @Builder(disableBuilder = true)
)
public interface PmsCompetencyMasterMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    PmsCompetencyMasterEntity toEntity(PmsCompetencyMasterDTO dto);

    PmsCompetencyMasterDTO toDTO(PmsCompetencyMasterEntity entity);

    List<PmsCompetencyMasterEntity> toEntityList(List<PmsCompetencyMasterDTO> dtoList);

    List<PmsCompetencyMasterDTO> toDTOList(List<PmsCompetencyMasterEntity> entityList);

    @Mapping(target = "id", ignore = true)
    void updateEntityFromDto(PmsCompetencyMasterDTO dto, @MappingTarget PmsCompetencyMasterEntity entity);
}
